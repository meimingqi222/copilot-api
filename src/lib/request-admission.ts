import type { Context } from "hono"

import type { Account } from "~/lib/accounts"
import type { ProtectedRouteKind } from "~/lib/protected-routes"
import type {
  ApiCredential,
  ProviderConnection,
  ProviderProtocol,
  RouteTarget,
} from "~/lib/provider-connections"

import { getAccountAvailability } from "~/lib/account-availability"
import { getAccount } from "~/lib/accounts"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { logger } from "~/lib/logger"
import { checkProtectedRouteGuard } from "~/lib/protected-route-guard"
import { PROVIDER_PROTOCOL_MAP } from "~/lib/provider-config"
import {
  connectionToAccount,
  findCredential,
  getProviderConnection,
  isCredentialAvailable,
  type ModelEndpoint,
} from "~/lib/provider-connections"
import { readAccountLegacyMetadata } from "~/lib/provider-connections/connection-metadata"
import {
  buildRouteTargets,
  commitRouteTargetAffinity,
  resolveModelRouting,
  selectRouteTarget,
} from "~/lib/route-target"
import { extractSessionIds } from "~/lib/routing"
import { state } from "~/lib/state"
import { isUserAllowedModel } from "~/lib/users"

/**
 * 统一路由解析结果。
 *
 * 由 `prepareRequestAdmission` 生成,基于 `buildRouteTargets` 候选池 +
 * `selectRouteTarget` 优先级/权重选择。
 *
 * - `connection`/`credential`: 始终填充。批次 3 后统一从 getProviderConnection 获取。
 * - `account`: 仅 account-derived connection 路径下填充(通过 connectionToAccount
 *   从 connection 派生，用于 native adapter 读取 provider-specific 状态)。
 */
export interface ProviderAdmission {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  /**
   * 仅在 target 来自 state.accounts(虚拟 connection)时填充。
   * 用于 native adapter 读取 account 的 provider-specific 状态字段。
   */
  account?: Account
  initiator?: "agent" | "user"
  /**
   * L0 session ids used for affinity (also needed on failover rebind so
   * the new credential sticks for the rest of the conversation).
   */
  sessionId?: string
  fallbackSessionId?: string
}

/**
 * 兼容别名 —— Step B 之后所有 admission 都是 ProviderAdmission。
 * 保留导出便于渐进式迁移调用点。
 */
export type RequestAdmission = ProviderAdmission

/**
 * 从 PROVIDER_PROTOCOL_MAP 获取 account 对应的协议。
 *
 * 纯数据表查询,无 services 依赖,测试环境也无需初始化 registry。
 * 新增 provider 时只需在 provider-config.ts 的 PROVIDER_PROTOCOL_MAP 追加一行。
 */
export function getAccountProtocol(account: Account): ProviderProtocol {
  return PROVIDER_PROTOCOL_MAP[account.provider]
}

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
}

export async function prepareRequestAdmission(
  c: Context,
  options: PrepareRequestAdmissionOptions,
): Promise<RequestAdmission> {
  c.set("model", options.model)
  enforceUserModelAccess(c, options.model)

  const { initiator } = resolveInitiatorWithClientHeader(
    c,
    options.inferredInitiator ?? "user",
  )
  c.set("guardInitiator", initiator)

  const routing = resolveModelRouting(options.model)
  const candidates = buildRouteTargets({
    connectionId: routing.connectionId,
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    aliasRestriction: routing.aliasRestriction,
    endpoint: options.endpoint,
  })

  const sessionIds = extractSessionIds({
    headers: options.sessionHeaders,
    payload: options.sessionPayload,
  })

  // Select without any upstream I/O so the guard can use the actual provider.
  // When no target exists, still run the guard with an explicit non-Copilot
  // scope before returning the route diagnostic.
  const target = selectRouteTarget(candidates, {
    sessionId: sessionIds.primaryId || undefined,
    fallbackSessionId: sessionIds.fallbackId || undefined,
    commitAffinity: false,
  })
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
    const diagnostic = diagnoseRouteFailure(options)
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
  commitRouteTargetAffinity(target, sessionIds.primaryId || undefined)

  const sessionFields = {
    sessionId: sessionIds.primaryId || undefined,
    fallbackSessionId: sessionIds.fallbackId || undefined,
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
  const found = findCredential(target.connectionId, target.credentialId)
  if (!connection || !found) {
    throw new HTTPError(
      "Route target resolution failed",
      new Response("Service Unavailable", { status: 503 }),
    )
  }
  // 批次 3：从 connection 派生 account（仅 account-derived connections）
  const account =
    readAccountLegacyMetadata(connection) ?
      connectionToAccount(connection)
    : undefined
  // Expose provider on the context so usage recording can attribute plain
  // (non-account-managed) provider connections correctly. Account-backed
  // paths derive provider from the final accountId at record time (preserving
  // failover correctness); plain connections fall back to this value.
  c.set("provider", account?.provider ?? target.protocol)
  return {
    target,
    connection,
    credential: found.credential,
    account,
    initiator,
    ...sessionFields,
  }
}

type FailureReason = "disabled" | "cooldown" | "quota" | "auth" | "unknown"

interface RouteFailureDiagnostic {
  message: string
  retryAfterSeconds: number
  /**
   * 主因:用于构造客户端可识别的 error.type / error.code。
   * 混合原因下取最严重的(quota > auth > cooldown > disabled > unknown)。
   */
  reason: FailureReason
}

function diagnoseRouteFailure(
  options: PrepareRequestAdmissionOptions,
): RouteFailureDiagnostic {
  const routing = resolveModelRouting(options.model)
  const allCandidates = buildRouteTargets({
    connectionId: routing.connectionId,
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    aliasRestriction: routing.aliasRestriction,
    endpoint: options.endpoint,
    onlyAvailable: false,
  })

  if (allCandidates.length === 0) {
    return {
      message: `No available route for model "${options.model}": model is not configured or not supported by any enabled provider`,
      retryAfterSeconds: 0,
      reason: "unknown",
    }
  }

  const { reasons, retryAfterSeconds } = analyzeCandidateReasons(allCandidates)

  if (reasons.size === 0) {
    // All candidates report available, yet selectRouteTarget returned null.
    // This is defensive and should be rare.
    return {
      message: `No available route for model "${options.model}": all candidates were filtered out by routing rules`,
      retryAfterSeconds: 0,
      reason: "unknown",
    }
  }

  const dominantReason = pickDominantFailureReason(reasons)

  if (reasons.size === 1) {
    const reason = [...reasons][0]
    if (reason === "quota") {
      return {
        message: `No available route for model "${options.model}": quota exhausted for all providers`,
        retryAfterSeconds,
        reason: dominantReason,
      }
    }
    if (reason === "cooldown") {
      return {
        message: `No available route for model "${options.model}": all providers are temporarily rate-limited`,
        retryAfterSeconds,
        reason: dominantReason,
      }
    }
    if (reason === "auth") {
      return {
        message: `No available route for model "${options.model}": authentication failed for all providers`,
        retryAfterSeconds: 0,
        reason: dominantReason,
      }
    }
    if (reason === "disabled") {
      return {
        message: `No available route for model "${options.model}": all providers are disabled`,
        retryAfterSeconds: 0,
        reason: dominantReason,
      }
    }
  }

  const reasonLabels = [...reasons]
    .map((r) => {
      switch (r) {
        case "quota": {
          return "quota exhausted"
        }
        case "cooldown": {
          return "rate-limited"
        }
        case "auth": {
          return "auth failed"
        }
        case "disabled": {
          return "disabled"
        }
        default: {
          return "unavailable"
        }
      }
    })
    .join(", ")

  return {
    message: `No available route for model "${options.model}": all providers are unavailable (${reasonLabels})`,
    retryAfterSeconds,
    reason: dominantReason,
  }
}

/**
 * 从混合原因中选最严重的,作为构造 error.type/code 的主因。
 * quota > auth > cooldown > disabled > unknown
 */
function pickDominantFailureReason(reasons: Set<FailureReason>): FailureReason {
  if (reasons.has("quota")) return "quota"
  if (reasons.has("auth")) return "auth"
  if (reasons.has("cooldown")) return "cooldown"
  if (reasons.has("disabled")) return "disabled"
  return "unknown"
}

/**
 * 按 endpoint 协议构造错误响应体。
 *
 * - Anthropic `/v1/messages`: `{ type: "error", error: { type, message } }`,
 *   `type` = `rate_limit_error`(cooldown)或 `billing_error`(quota)。
 *   参考:docs.anthropic.com/en/api/errors
 * - OpenAI(`/v1/chat/completions`、`/v1/responses`、`/v1/embeddings`):
 *   `{ error: { message, type, param, code } }`,
 *   `code` = `insufficient_quota`(quota)或 `rate_limit_exceeded`(其他)。
 *   参考:platform.openai.com/docs/guides/error-codes
 */
function buildRateLimitResponseBody(
  endpoint: ModelEndpoint,
  diagnostic: RouteFailureDiagnostic,
): string {
  const isAnthropic = endpoint === "messages"
  if (isAnthropic) {
    const errorType =
      diagnostic.reason === "quota" ? "billing_error" : "rate_limit_error"
    return JSON.stringify({
      type: "error",
      error: {
        type: errorType,
        message: diagnostic.message,
      },
    })
  }
  const code =
    diagnostic.reason === "quota" ? "insufficient_quota" : "rate_limit_exceeded"
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
function buildRateLimitResponse(
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

function analyzeCandidateReasons(candidates: Array<RouteTarget>): {
  reasons: Set<FailureReason>
  retryAfterSeconds: number
} {
  const reasons = new Set<FailureReason>()
  let retryAfterSeconds = 0

  for (const candidate of candidates) {
    // 批次 3：RouteTarget.account 已删除，通过 connectionId 查找 account
    const account = getAccount(candidate.connectionId)
    if (account) {
      const availability = getAccountAvailability(account)
      if (!availability.available) {
        const reason = mapAccountReason(availability.reason)
        reasons.add(reason)
        // quota 也提取 retryAfterSeconds(凭据配额耗尽时也有 cooldownUntil,
        // 通常是 24h 自动恢复窗口),客户端据此退避,避免立即重试雪崩。
        if (
          (reason === "cooldown" || reason === "quota")
          && availability.retryAfterSeconds > retryAfterSeconds
        ) {
          retryAfterSeconds = availability.retryAfterSeconds
        }
      }
      continue
    }

    if (candidate.connectionId && candidate.credentialId) {
      const diagnostic = getCredentialFailureDiagnostic(
        candidate.connectionId,
        candidate.credentialId,
      )
      if (diagnostic) {
        reasons.add(diagnostic.reason)
        if (diagnostic.retryAfterSeconds > retryAfterSeconds) {
          retryAfterSeconds = diagnostic.retryAfterSeconds
        }
      }
    }
  }

  return { reasons, retryAfterSeconds }
}

function getCredentialFailureDiagnostic(
  connectionId: string,
  credentialId: string,
): { reason: FailureReason; retryAfterSeconds: number } | null {
  const connection = getProviderConnection(connectionId)
  if (!connection) return null

  // Connection-level disable takes precedence.
  if (!connection.enabled) {
    return { reason: "disabled", retryAfterSeconds: 0 }
  }

  const credential = connection.credentials.find((c) => c.id === credentialId)
  if (!credential) return null

  // Credential is available — no failure to report. This happens because
  // buildRouteTargets is called with onlyAvailable: false for diagnosis,
  // so the candidate list includes both available and unavailable entries.
  if (isCredentialAvailable(credential)) {
    return null
  }

  const reason = mapCredentialReason(credential.status)
  let retryAfterSeconds = 0
  // cooldown 和 quota_exhausted 都有 cooldownUntil(冷却 / 配额恢复窗口)。
  // 提取剩余秒数让客户端据此退避,避免立即重试导致雪崩。
  if (
    (reason === "cooldown" || reason === "quota")
    && credential.cooldownUntil
    && credential.cooldownUntil > Date.now()
  ) {
    retryAfterSeconds = Math.ceil(
      (credential.cooldownUntil - Date.now()) / 1000,
    )
  }
  return { reason, retryAfterSeconds }
}

function mapAccountReason(
  reason: "available" | "disabled" | "cooldown" | "quota" | "error",
): FailureReason {
  switch (reason) {
    case "disabled": {
      return "disabled"
    }
    case "cooldown": {
      return "cooldown"
    }
    case "quota": {
      return "quota"
    }
    case "error": {
      return "auth"
    }
    case "available": {
      return "unknown"
    }
    default: {
      return "unknown"
    }
  }
}

function mapCredentialReason(status: string | undefined): FailureReason {
  switch (status) {
    case "disabled": {
      return "disabled"
    }
    case "cooldown": {
      return "cooldown"
    }
    case "quota_exhausted": {
      return "quota"
    }
    case "auth_error": {
      return "auth"
    }
    default: {
      return "unknown"
    }
  }
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

/**
 * 在请求失败时尝试切换到下一个候选 RouteTarget。
 * 支持 Connection 和 Account 两种 target。
 *
 * When session affinity is enabled, the rebinding options force a new pick
 * and update the session → credential map (CPA failover behavior).
 */
export function switchToNextRouteTarget(
  _current: RouteTarget,
  modelId: string,
  endpoint: ModelEndpoint,
  exclude: Set<string>,
  session?: { sessionId?: string; fallbackSessionId?: string },
): RouteTarget | null {
  const routing = resolveModelRouting(modelId)
  const candidates = buildRouteTargets({
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    aliasRestriction: routing.aliasRestriction,
    endpoint,
  })
  return selectRouteTarget(candidates, {
    exclude,
    sessionId: session?.sessionId,
    fallbackSessionId: session?.fallbackSessionId,
    rebindAffinity: true,
  })
}

/**
 * WS-only same-protocol account rotation selector for in-round Responses
 * failover. Deliberately separate from `switchToNextRouteTarget` (which the
 * HTTP dispatch path and its cross-system failover test depend on), because
 * this selector adds three WS-specific constraints:
 *
 *   1. Forwards `routing.connectionId` so an explicit `connectionId/model` pin
 *      is honored — never switches to a different connection (returns null
 *      once the pinned connection's account is exhausted).
 *   2. Keeps the same protocol as the initial target — a bare model resolving
 *      to both codex + xAI must not cross protocols mid-turn.
 *   3. Only returns account-backed candidates, since rotation resolves the
 *      account and calls `createResponses({ account })`.
 *
 * Returns null when no other same-protocol, account-backed candidate remains
 * (excluding those already in `tried`).
 */
export function selectNextResponsesWsTarget(
  initialTarget: RouteTarget,
  modelId: string,
  tried: Set<string>,
  session?: { sessionId?: string; fallbackSessionId?: string },
): RouteTarget | null {
  const routing = resolveModelRouting(modelId)
  const candidates = buildRouteTargets({
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    connectionId: routing.connectionId,
    aliasRestriction: routing.aliasRestriction,
    endpoint: "responses",
  }).filter(
    (candidate) =>
      candidate.protocol === initialTarget.protocol
      && resolveConnectionFromTarget(candidate)?.account !== undefined,
  )
  return selectRouteTarget(candidates, {
    exclude: tried,
    sessionId: session?.sessionId,
    fallbackSessionId: session?.fallbackSessionId,
    rebindAffinity: true,
  })
}

/**
 * 把 RouteTarget 解析为 ProviderAdmission 信息。
 *
 * 批次 3 后统一从 getProviderConnection 查找真实 connection/credential。
 * account-derived connections 通过 connectionToAccount 派生 account 字段。
 *
 * 返回 null 表示无法解析(调用方应抛出原始错误)。
 */
export function resolveConnectionFromTarget(target: RouteTarget): {
  connection: ProviderConnection
  credential: ApiCredential
  account?: Account
} | null {
  // 批次 3：target.account 已删除，统一走 getProviderConnection
  const connection = getProviderConnection(target.connectionId)
  if (!connection) return null
  const found = findCredential(target.connectionId, target.credentialId)
  if (!found) return null
  const account =
    readAccountLegacyMetadata(connection) ?
      connectionToAccount(connection)
    : undefined
  return { connection, credential: found.credential, account }
}
