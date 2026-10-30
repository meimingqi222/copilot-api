import type { Context } from "hono"

import type { ProtectedRouteKind } from "~/lib/protected-routes"
import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import {
  diagnoseRouteFailure,
  describeCandidates,
  type RouteFailureDiagnostic,
} from "~/lib/route-diagnostics"

import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { logger } from "~/lib/logger"
import {
  recordRequestedServiceTier,
  recordRoutedServiceTier,
} from "~/lib/service-tier-trace"
import { measurePerformanceStage } from "~/lib/request-performance"
import { checkProtectedRouteGuard } from "~/lib/protected-route-guard"
import {
  connectionProvider,
  getProviderConnection,
  type ModelEndpoint,
} from "~/lib/provider-connections"
import { findEffectiveCredential } from "~/lib/provider-connections/anonymous-credential"
import { patchRequestLog, publishTraceSnapshot } from "~/lib/request-log"
import {
  buildGroupRouteTargets,
  buildRouteTargets,
  commitRouteTargetAffinity,
  resolveModelRouting,
  selectGroupRouteTarget,
  selectRouteTarget,
} from "~/lib/route-target"
import { extractSessionIds, extractSessionTurn } from "~/lib/routing"
import {
  classifierTargetOf,
  classifyIntent,
  EFFORT_LEVELS,
  getRoutingGroup,
  isGroupEffortLevel,
  memberEffort,
  memberFast,
  type GroupAffinityMode,
  type RuleContext,
  type RoutingGroup,
} from "~/lib/routing-groups"
import type { GroupRoutingMode } from "~/lib/routing-groups/types"
import {
  applyGroupOverrides,
  captureGroupOverrideBaseline,
  type GroupOverrideBaseline,
  type AppliedGroupOverrides,
} from "~/lib/routing-groups/apply"
import {
  orderMembersForRouting,
  parseGroupReference,
  resolveGroupMember,
  splitMember,
} from "~/lib/routing-groups/resolve"
import { state } from "~/lib/state"
import { groupAffinityScope } from "~/lib/route-target/group-policy"
import { isUserAllowedModel } from "~/lib/users"
import { safeOrigin } from "~/lib/utils"

/**
 * 统一路由解析结果。
 *
 * 由 `prepareRequestAdmission` 生成,基于 `buildRouteTargets` 候选池 +
 * `selectRouteTarget` 优先级/权重选择。
 *
 * - `connection`/`credential`: 始终填充。批次 3 后统一从 getProviderConnection 获取。
 */
export interface ProviderAdmission {
  compact?: boolean
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  initiator?: "agent" | "user"
  /**
   * L0 session ids used for affinity (also needed on failover rebind so
   * the new credential sticks for the rest of the conversation).
   */
  sessionId?: string
  fallbackSessionId?: string
  /**
   * The request's current turn key (turn-stable across tool-result rounds),
   * used by the `turn` affinity mode and carried across failover.
   */
  turnKey?: string
  /**
   * The routing-group member that answered this request, when the model was a
   * `group/<id>` reference. Absent on a plain model name.
   */
  group?: GroupDecision
  /**
   * The group's members in the order a retry should try them, so failover can
   * walk the whole group rather than the single member that answered. Absent on
   * a plain model name.
   */
  groupMembers?: Array<string>
  /**
   * What that member's `:effort` / `:fast` wrote onto the request payload. The
   * member's suffixes are routing vocabulary, not part of the model id, so this
   * is where "the group asked for high effort, fast lane" becomes observable.
   */
  groupOverrides?: AppliedGroupOverrides
  groupOverrideBaseline?: GroupOverrideBaseline
}

/**
 * 兼容别名 —— Step B 之后所有 admission 都是 ProviderAdmission。
 * 保留导出便于渐进式迁移调用点。
 */
export type RequestAdmission = ProviderAdmission

interface PrepareRequestAdmissionOptions {
  routeKind?: ProtectedRouteKind
  model: string
  endpoint: ModelEndpoint
  maxTokens?: number
  stream?: boolean
  inferredInitiator?: "agent" | "user"
  messageContent?: string
  /**
   * Incoming request headers used for session-affinity extraction
   * (session_id, prompt_cache_key, x-claude-code-session-id, …).
   */
  sessionHeaders?: Record<string, string | undefined>
  /**
   * Request body used for session-affinity extraction
   * (metadata.user_id, prompt_cache_key, messages hash, …).
   */
  sessionPayload?: unknown
  /**
   * 上下文压缩请求：候选池只保留原生支持 `/responses/compact` 的协议，
   * 且跳过一切翻译 target（见 BuildRouteTargetsOptions.compact）。
   */
  compact?: boolean
  /** 请求的思考等级，写入请求日志便于排查 */
  reasoningEffort?: string
}

/**
 * A `group/<id>` model reference, resolved for one request.
 *
 * The parts admission already holds (the requested model, the flattened message
 * text, the request body) are what a group rule can be judged against, so the
 * decision is a function of those alone — no request context, no disk beyond
 * the group store itself. Splitting it out keeps `prepareRequestAdmission` the
 * only thing that has to know about routing, and lets the decision be exercised
 * directly.
 */
export interface GroupDecisionInput {
  /** The model the client asked for; may be a `group/<id>` reference. */
  model: string
  /** Flattened message text: the request's size, and what a classifier reads. */
  messageContent?: string
  /** Request body, scanned read-only for image parts. */
  sessionPayload?: unknown
  /** The effort the client asked for, as it spelled it. */
  reasoningEffort?: string
  /** Initiator inferred from the payload, before the client header. */
  inferredInitiator?: "agent" | "user"
  /** Initiator after the client header has been taken into account. */
  initiator?: "agent" | "user"
  /** The request is a context compaction. */
  compact?: boolean
  /**
   * The request's turn key (stable across the tool-result rounds of one turn),
   * for a group whose routing is `rotate`.
   */
  turnKey?: string
}

/** The member a routing group chose for this request. */
interface GroupDecision {
  /** Effective policy; an explicit rule keeps its chosen member first. */
  routing?: GroupRoutingMode
  /** Classifier effort, independent of a particular member's fixed suffix. */
  automaticEffort?: string
  /** Id of the group that answered. */
  groupId: string
  /** The member as written in the group, `:effort` / `:fast` included. */
  member: string
  /** The bare `provider/model` the request should be routed with. */
  model: string
  /** Effort the member asked for, when it carries one. */
  effort?: string
  /** The member asked for its fast variant. */
  fast: boolean
  /** Index of the rule that chose the member, when a rule matched. */
  ruleIndex?: number
  /**
   * The group's members in the order the request should try them, the lead
   * first (see `orderMembersForRouting`). Failover walks this list.
   */
  members: Array<string>
  /** The group's affinity override, when it names one. */
  affinity?: GroupAffinityMode
}

/** Seams the decision reads through, so a test can drive it without state. */
export interface GroupDecisionDeps {
  /** Defaults to the routing-group store. */
  getGroup?: (id: string) => Promise<RoutingGroup | undefined>
  /** Defaults to the registered intent classifier (a no-op until one exists). */
  classify?: typeof classifyIntent
  /** Defaults to `new Date()`. */
  now?: () => Date
  /**
   * Orders member ids by allowance, best first, for a group whose routing is
   * `smart` / `usage`. Defaults to leaving the order as written.
   */
  rankByAllowance?: (
    members: Array<string>,
    mode: "smart" | "usage",
  ) => Array<string>
}

/**
 * Rough request size in tokens.
 *
 * A group rule only ever compares `tokens` against a threshold, and admission
 * has no model in hand for the tokenizer's constants, so a fixed four
 * characters per token is the estimate here. An empty body is "unknown", not
 * zero: a rule asking for a minimum size then simply does not match.
 */
function estimateGroupTokens(text: string | undefined): number | undefined {
  if (typeof text !== "string" || text === "") return undefined
  return Math.ceil(text.length / 4)
}

/** Content-part types that mean "this request carries an image". */
const IMAGE_PART_TYPES = new Set(["image", "image_url", "input_image"])

/**
 * Whether the request body carries an image, read-only and bounded.
 *
 * Routing only asks yes/no, so the scan stops at the first image part. It walks
 * plain objects and arrays only, at a shallow depth, and treats a compact set
 * of spellings as an image: a content part's `type`, or the fields only an
 * image block has. Nested group members do not exist yet, so nothing else in
 * the payload is interpreted.
 */
function sessionPayloadHasImage(payload: unknown): boolean {
  const seen = new Set<object>()

  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 8 || node === null || typeof node !== "object") return false
    if (seen.has(node)) return false
    seen.add(node)

    if (Array.isArray(node)) {
      return node.some((item) => visit(item, depth + 1))
    }

    const record = node as Record<string, unknown>
    const type = record["type"]
    if (
      typeof type === "string"
      && IMAGE_PART_TYPES.has(type.trim().toLowerCase())
    ) {
      return true
    }
    if (record["image_url"] !== undefined || record["imageUrl"] !== undefined) {
      return true
    }
    if (
      record["inlineData"] !== undefined
      || record["inline_data"] !== undefined
    ) {
      return true
    }

    return Object.values(record).some((value) => visit(value, depth + 1))
  }

  return visit(payload, 0)
}

/**
 * Best-effort "is this id a real model" check, without a model catalog.
 *
 * Anything of the `provider/model` shape counts as a model — that is how this
 * proxy names what it routes to — *unless* it ends in the suffix chain a group
 * member may carry (`:effort`, `:fast`). Reading those as models too would hand
 * the router `vendor/model:fast` instead of the model it decorates, which is
 * exactly the id the suffix parser exists to strip.
 */
function looksLikeKnownModel(id: string): boolean {
  if (!id.includes("/")) return false
  const trimmed = id.trim()
  return (
    memberEffort(trimmed) === undefined && memberFast(trimmed) === undefined
  )
}

/** The distinct intents a group's rules ask a classifier about. */
function groupRuleIntents(group: RoutingGroup): Array<string> {
  const intents = new Set<string>()
  for (const rule of group.rules ?? []) {
    const intent = typeof rule?.intent === "string" ? rule.intent.trim() : ""
    if (intent !== "") intents.add(intent)
  }
  return [...intents]
}

/**
 * Resolve a `group/<id>` model reference to the member that leads this request.
 *
 * Returns undefined when the model is not a group reference, the group is
 * unknown, or the group resolves to nothing — the caller then keeps the model
 * the client asked for, exactly as before groups existed. Never throws: a group
 * is an optimisation over a plain model name, so a broken group must not be
 * able to fail a request.
 */
export async function resolveGroupDecision(
  input: GroupDecisionInput,
  deps: GroupDecisionDeps = {},
): Promise<GroupDecision | undefined> {
  const groupId = parseGroupReference(input.model)
  if (groupId === undefined) return undefined

  const getGroup = deps.getGroup ?? getRoutingGroup
  const group = await getGroup(groupId)
  if (!group) return undefined

  const ctx: RuleContext = {
    tokens: estimateGroupTokens(input.messageContent),
    images: sessionPayloadHasImage(input.sessionPayload),
    effort: input.reasoningEffort,
    agent: input.initiator ?? input.inferredInitiator ?? "user",
    compact: input.compact,
    at: deps.now?.() ?? new Date(),
  }

  // Only a group that names a classifier pays for one, and only for the
  // intents its rules actually test. `classifyIntent` resolves undefined when
  // nothing is registered, which leaves the rule's other conditions to decide.
  const classifier = classifierTargetOf(group)
  if (classifier) {
    const intents = groupRuleIntents(group)
    if (intents.length > 0) {
      const classify = deps.classify ?? classifyIntent
      const intent = await classify({
        text: input.messageContent ?? "",
        intents,
        provider: classifier.provider,
        model: classifier.model,
      })
      if (intent !== undefined) ctx.intent = intent
    }
  }

  const resolved = resolveGroupMember(group, ctx, {
    knownModel: looksLikeKnownModel,
  })
  if (!resolved) return undefined

  // The members in the order this request should try them, the lead first.
  const members = orderMembersForRouting(group, resolved.member, {
    turnKey: input.turnKey,
    rankByAllowance: deps.rankByAllowance,
    ruleMatched: resolved.ruleIndex !== undefined,
  })
  const lead = splitMember(members[0] ?? resolved.member, looksLikeKnownModel)

  // `effort: auto` asks the classifier how hard the turn is, unless the member
  // carries an effort of its own.
  let automaticEffort: string | undefined
  const mayChooseAnother =
    resolved.ruleIndex === undefined
    && (group.routing === "smart" || group.routing === "usage")
  if (
    (lead.effort === undefined || mayChooseAnother)
    && group.effort === "auto"
    && classifier
  ) {
    const levels =
      group.levels && group.levels.length > 0 ?
        group.levels
      : [...EFFORT_LEVELS]
    const classify = deps.classify ?? classifyIntent
    const level = await classify({
      text: input.messageContent ?? "",
      intents: levels,
      provider: classifier.provider,
      model: classifier.model,
    })
    if (typeof level === "string" && isGroupEffortLevel(level))
      automaticEffort = level
  }
  const effort = lead.effort ?? automaticEffort

  return {
    groupId: resolved.groupId,
    routing:
      resolved.ruleIndex === undefined ? (group.routing ?? "order") : "order",
    ...(automaticEffort === undefined ? {} : { automaticEffort }),
    member: members[0] ?? resolved.member,
    model: lead.model,
    ...(effort === undefined ? {} : { effort }),
    fast: lead.fast,
    ...(resolved.ruleIndex === undefined ?
      {}
    : { ruleIndex: resolved.ruleIndex }),
    members,
    ...(group.affinity === undefined ? {} : { affinity: group.affinity }),
  }
}

/** Follow the selected account's member, rather than the provisional group lead. */
export function retargetGroupDecision(
  decision: GroupDecision,
  target: RouteTarget,
): GroupDecision {
  if (!target.groupMember) return decision
  const selected = splitMember(target.groupMember, looksLikeKnownModel)
  return {
    ...decision,
    member: target.groupMember,
    model: selected.model,
    effort: selected.effort ?? decision.automaticEffort,
    fast: selected.fast,
  }
}

function commitAdmissionAffinity(
  target: RouteTarget,
  sessionId: string | undefined,
  turnKey: string | undefined,
  group?: GroupDecision,
): void {
  const scope = groupAffinityScope(group)
  commitRouteTargetAffinity(target, sessionId, {
    affinityMode: group?.affinity,
    affinityScope: scope,
    turnKey,
  })
}

export async function prepareRequestAdmission(
  c: Context,
  options: PrepareRequestAdmissionOptions,
): Promise<RequestAdmission> {
  return measurePerformanceStage(c, "admissionMs", () =>
    prepareRequestAdmissionImpl(c, options),
  )
}

async function prepareRequestAdmissionImpl(
  c: Context,
  options: PrepareRequestAdmissionOptions,
): Promise<RequestAdmission> {
  c.set("model", options.model)
  recordRequestedServiceTier(c, options.sessionPayload)
  enforceUserModelAccess(c, options.model)

  const { initiator } = resolveInitiatorWithClientHeader(
    c,
    options.inferredInitiator ?? "user",
  )
  c.set("guardInitiator", initiator)

  // A `group/<id>` reference is resolved before anything looks at the model:
  // the group's chosen member is what routing then works with, while the group
  // reference stays the model the client asked for (it is what the guard, the
  // usage attribution and `modelRequested` in the trace all keep showing).
  // Group logic is best effort — a group that cannot answer leaves the request
  // exactly as a literal model name would.
  let groupDecision: GroupDecision | undefined
  let groupOverrides: AppliedGroupOverrides | undefined
  let routingGroup: RoutingGroup | null | undefined
  try {
    groupDecision = await measurePerformanceStage(c, "routingDecisionMs", () =>
      resolveGroupDecision({
        model: options.model,
        messageContent: options.messageContent,
        sessionPayload: options.sessionPayload,
        reasoningEffort: options.reasoningEffort,
        inferredInitiator: options.inferredInitiator,
        initiator,
        compact: options.compact,
        turnKey:
          extractSessionTurn(options.sessionPayload).turnKey || undefined,
      }),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(
      `Routing group resolution failed for "${options.model}": ${message}`,
    )
  }

  if (groupDecision) {
    try {
      routingGroup = await getRoutingGroup(groupDecision.groupId)
    } catch {
      // Best effort lookup of the routing group
    }

    patchRequestLog(c, {
      failoverReason: `routing-group:${groupDecision.groupId}→${groupDecision.member}`,
      routingGroupId: groupDecision.groupId,
      routingGroupName: routingGroup?.name || groupDecision.groupId,
      routingGroupMembers: groupDecision.members,
      routingGroupSelectedMember: groupDecision.member,
      routingStrategy: routingGroup?.routing || "order",
    })
  }

  const routedModel = groupDecision?.model ?? options.model

  const routing = resolveModelRouting(routedModel)
  const candidates = buildRouteTargets({
    connectionId: routing.connectionId,
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    aliasRestriction: routing.aliasRestriction,
    endpoint: options.endpoint,
    compact: options.compact,
  })

  const sessionIds = extractSessionIds({
    headers: options.sessionHeaders,
    payload: options.sessionPayload,
  })
  const sessionTurn = extractSessionTurn(options.sessionPayload)

  // Select without any upstream I/O so the guard can use the actual provider.
  // When no target exists, still run the guard with an explicit non-Copilot
  // scope before returning the route diagnostic.
  const target =
    groupDecision && groupDecision.members.length > 0 ?
      selectGroupRouteTarget(groupDecision.members, {
        routing: groupDecision.routing,
        groupId: groupDecision.groupId,
        endpoint: options.endpoint,
        compact: options.compact,
        sessionId: sessionIds.primaryId || undefined,
        fallbackSessionId: sessionIds.fallbackId || undefined,
        turnKey: sessionTurn.turnKey || undefined,
        affinityMode: groupDecision.affinity,
        commitAffinity: false,
      })
    : selectRouteTarget(candidates, {
        sessionId: sessionIds.primaryId || undefined,
        fallbackSessionId: sessionIds.fallbackId || undefined,
        turnKey: sessionTurn.turnKey || undefined,
        commitAffinity: false,
      })
  const groupOverrideBaseline =
    groupDecision ?
      captureGroupOverrideBaseline(options.sessionPayload)
    : undefined
  if (groupDecision && target) {
    groupDecision = retargetGroupDecision(groupDecision, target)
    groupOverrides = applyGroupOverrides(
      options.sessionPayload,
      groupDecision,
      {
        endpoint: options.endpoint,
        baseline: groupOverrideBaseline,
      },
    )
  }
  const appliedEffort = groupOverrides?.effort ?? options.reasoningEffort
  let guardProvider = "unroutable"
  if (target) {
    guardProvider =
      target.protocol === "copilot-native" ? "copilot" : target.protocol
  }
  try {
    checkProtectedRouteGuard(c, {
      routeKind: options.routeKind,
      model: options.model,
      maxTokens: options.maxTokens,
      stream: options.stream,
      messageContent: options.messageContent,
      provider: guardProvider,
    })
  } catch (error) {
    if (error instanceof Error) {
      logger.warn(
        `Request admission guard rejected request: ${JSON.stringify({
          path: c.req.path,
          model: options.model,
          routeKind: options.routeKind,
          protocol: target?.protocol,
          maxTokens: options.maxTokens,
          stream: options.stream ?? false,
          errorName: error.name,
          errorMessage: error.message,
        })}`,
      )
    }
    throw error
  }

  if (!target) {
    const diagnostic = diagnoseRouteFailure(options, routedModel)
    patchRequestLog(c, {
      modelRequested: options.model,
      endpoint: options.endpoint,
      apiKind: options.endpoint as import("~/lib/log-store").ApiKind,
      streaming: options.stream,
      reasoningEffort: appliedEffort,
      initiator,
      outcome: "failed",
      error: diagnostic.message,
      // 与线上错误体一致:额度耗尽按限流报告。
      errorType:
        diagnostic.reason === "quota" ? "rate_limit_exceeded" : "no_route",
      upstreamStatus: 429,
      retryAfterMs: diagnostic.retryAfterSeconds * 1000 || undefined,
      failoverReason: diagnostic.reason,
      diagnosticError: {
        origin: "admission",
        kind: diagnostic.reason === "quota" ? "quota_exhausted" : "no_route",
        message: diagnostic.message,
        status: 429,
        retryAfterMs: diagnostic.retryAfterSeconds * 1000 || undefined,
      },
    })
    throw new HTTPError(
      diagnostic.message,
      buildRateLimitResponse(options.endpoint, diagnostic),
      buildRateLimitResponseBody(options.endpoint, diagnostic),
    )
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Commit the previewed target only after all admission checks pass.
  commitAdmissionAffinity(
    target,
    sessionIds.primaryId || undefined,
    sessionTurn.turnKey || undefined,
    groupDecision,
  )

  const sessionFields = {
    sessionId: sessionIds.primaryId || undefined,
    fallbackSessionId: sessionIds.fallbackId || undefined,
    turnKey: sessionTurn.turnKey || undefined,
  }

  // 批次 3：target.account 已删除，统一走 getProviderConnection。
  // account-derived connections 已在 stateRoot.connections 中。
  // 类型安全检查：确保 connectionId 和 credentialId 存在
  if (!target.connectionId || !target.credentialId) {
    throw new HTTPError(
      "Invalid route target: missing connection or credential ID",
      new Response("Bad Request", { status: 400 }),
    )
  }

  const connection = getProviderConnection(target.connectionId)
  const credential =
    connection && findEffectiveCredential(connection, target.credentialId)
  if (!connection || !credential) {
    throw new HTTPError(
      "Route target resolution failed",
      new Response("Service Unavailable", { status: 503 }),
    )
  }
  // 批次 3/Phase 2e：admission 不再携带 account。provider 通过
  // connectionProvider 从 connection 原生派生（account-managed 走
  // metadata.provider，plain connection 走 protocol）。
  const provider = connectionProvider(connection)
  recordRoutedServiceTier(c, options.sessionPayload)
  // Expose provider on the context so usage recording can attribute plain
  // (non-account-managed) provider connections correctly. Account-backed
  // paths derive provider from the final accountId at record time (preserving
  // failover correctness); plain connections fall back to this value.
  c.set("provider", provider)
  patchRequestLog(c, {
    modelRequested: options.model,
    modelUpstream: target.upstreamModelId,
    endpoint: target.endpoint,
    provider,
    protocol: target.protocol,
    connectionId: target.connectionId,
    connectionName: connection.name,
    credentialId: target.credentialId,
    credentialLabel: credential.label,
    upstreamBaseUrl: safeOrigin(connection.baseUrl),
    isTranslated: target.isTranslated,
    isWildcard: target.isWildcard,
    initiator,
    sessionId: sessionIds.primaryId || undefined,
    streaming: options.stream,
    reasoningEffort: appliedEffort,
    ...(groupDecision ?
      {
        failoverReason: `routing-group:${groupDecision.groupId}→${groupDecision.member}`,
        routingGroupId: groupDecision.groupId,
        routingGroupName: routingGroup?.name || groupDecision.groupId,
        routingGroupMembers: groupDecision.members,
        routingGroupSelectedMember: groupDecision.member,
        routingStrategy: routingGroup?.routing || "order",
      }
    : {}),
  })

  // Candidate paths: every route routing could have taken, so the admin trace
  // view can show the chosen one plus why the alternates were passed over.
  // Built from the *unfiltered* pool so temporarily-unavailable candidates
  // (cooldown / quota / disabled) still appear.
  const allCandidates =
    groupDecision && groupDecision.members.length > 0 ?
      buildGroupRouteTargets(groupDecision.members, {
        endpoint: options.endpoint,
        compact: options.compact,
        onlyAvailable: false,
      })
    : buildRouteTargets({
        connectionId: routing.connectionId,
        legacyProvider: routing.legacyProvider,
        accountPrefix: routing.accountPrefix,
        publicModelId: routing.modelId,
        aliasRestriction: routing.aliasRestriction,
        endpoint: options.endpoint,
        onlyAvailable: false,
        compact: options.compact,
      })
  patchRequestLog(c, {
    candidates: describeCandidates(allCandidates, target),
  })
  publishTraceSnapshot(c, "update")

  return {
    target,
    connection,
    credential,
    compact: options.compact,
    initiator,
    ...sessionFields,
    ...(groupDecision ?
      {
        group: groupDecision,
        groupMembers: groupDecision.members,
        groupOverrideBaseline,
        ...(groupOverrides ? { groupOverrides } : {}),
      }
    : {}),
  }
}

/**
 * 按 endpoint 协议构造错误响应体。
 *
 * - Anthropic `/v1/messages`: `{ type: "error", error: { type, message } }`,
 *   `type` = `rate_limit_error`。
 *   参考:docs.anthropic.com/en/api/errors
 * - OpenAI(`/v1/chat/completions`、`/v1/responses`、`/v1/embeddings`):
 *   `{ error: { message, type, param, code } }`,
 *   `code` = `rate_limit_exceeded`。
 *   参考:platform.openai.com/docs/guides/error-codes
 *
 * 额度耗尽(订阅窗口用尽)也是一种限流:重置时刻写在 `Retry-After` 里,客户端
 * 自己等到那时重试即可。若报成 `insufficient_quota`/`billing_error`,Codex 这类
 * 客户端会把它当终态直接结束本轮,窗口恢复后也不会自动继续。
 */
export function buildRateLimitResponseBody(
  endpoint: ModelEndpoint,
  diagnostic: RouteFailureDiagnostic,
): string {
  const isAnthropic = endpoint === "messages"
  if (isAnthropic) {
    return JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: diagnostic.message,
      },
    })
  }
  const code = "rate_limit_exceeded"
  return JSON.stringify({
    error: {
      message: diagnostic.message,
      type: code,
      param: null,
      code,
    },
  })
}

/**
 * 构造 429 响应,包含 3 个客户端 SDK 都会读取的退避 headers:
 *
 * - `Retry-After`:HTTP 标准,秒。所有 SDK 默认读取此 header。
 * - `retry-after-ms`:Anthropic 风格,毫秒。oh-my-pi 等客户端优先读取,
 *   提供更高精度(避免 0.5s 被 floor 到 0)。
 * - `x-ratelimit-reset`:OpenAI 风格,秒。oh-my-pi 等客户端作为补充信号读取。
 *
 * 没有退避时间(reasons 没有 cooldown/quota)时不设置这些 headers,
 * 让客户端走默认指数退避。
 */
export function buildRateLimitResponse(
  endpoint: ModelEndpoint,
  diagnostic: RouteFailureDiagnostic,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (diagnostic.retryAfterSeconds > 0) {
    const retryAfterMs = diagnostic.retryAfterSeconds * 1000
    headers["Retry-After"] = String(diagnostic.retryAfterSeconds)
    headers["retry-after-ms"] = String(retryAfterMs)
    headers["x-ratelimit-reset"] = String(diagnostic.retryAfterSeconds)
  }
  return new Response(buildRateLimitResponseBody(endpoint, diagnostic), {
    status: 429,
    headers,
  })
}

function enforceUserModelAccess(c: Context, model: string): void {
  const user = c.get("user")
  if (!user || isUserAllowedModel(user, model)) {
    return
  }

  throw new HTTPError(
    `Model "${model}" is not enabled for user "${user.username}"`,
    new Response("Forbidden", { status: 403 }),
  )
}
