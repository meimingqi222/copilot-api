import type { Context } from "hono"

import consola from "consola"

import type { Account, AccountProvider } from "~/lib/accounts"
import type { ProtectedRouteKind } from "~/lib/protected-routes"
import type {
  ApiCredential,
  ProviderConnection,
  ProviderProtocol,
  RouteTarget,
} from "~/lib/provider-connections"

import { getAccountAvailability } from "~/lib/account-availability"
import { parseModelReference } from "~/lib/accounts"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { checkProtectedRouteGuard } from "~/lib/protected-route-guard"
import {
  findCredential,
  getProviderConnection,
  isCredentialAvailable,
  type ModelEndpoint,
} from "~/lib/provider-connections"
import {
  buildRouteTargets,
  resolveModelRouting,
  selectRouteTarget,
} from "~/lib/route-target"
import { state } from "~/lib/state"
import { isUserAllowedModel } from "~/lib/users"

/**
 * 路由解析结果。
 *
 * - `kind: "account"`: Account-based target (Copilot/Codebuff/Windsurf/Mimo native adapter)。
 * - `kind: "provider"`: ProviderConnection-based target (OpenAI/Anthropic-compatible adapter)。
 *
 * 统一由 `buildRouteTargets` 生成候选池,`selectRouteTarget` 按优先级/权重选取。
 */
export type RequestAdmission = AccountAdmission | ProviderAdmission

export interface AccountAdmission {
  kind: "account"
  account: Account
  target: RouteTarget
  initiator?: "agent" | "user"
}

export interface ProviderAdmission {
  kind: "provider"
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  initiator?: "agent" | "user"
}

const ACCOUNT_PROTOCOLS: Record<AccountProvider, ProviderProtocol> = {
  copilot: "copilot-native",
  codebuff: "codebuff-native",
  windsurf: "windsurf-native",
  "mimo-aistudio": "mimo-native",
  codex: "codex-native",
  claude: "claude-native",
  antigravity: "antigravity-native",
  kimi: "kimi-native",
  xai: "xai-native",
}

export function getAccountProtocol(account: Account): ProviderProtocol {
  return ACCOUNT_PROTOCOLS[account.provider]
}

interface PrepareRequestAdmissionOptions {
  routeKind?: ProtectedRouteKind
  model: string
  endpoint: ModelEndpoint
  maxTokens?: number
  stream?: boolean
  inferredInitiator?: "agent" | "user"
  messageContent?: string
}

export async function prepareRequestAdmission(
  c: Context,
  options: PrepareRequestAdmissionOptions,
): Promise<RequestAdmission> {
  c.set("model", options.model)
  enforceUserModelAccess(c, options.model)

  try {
    checkProtectedRouteGuard(c, {
      routeKind: options.routeKind,
      model: options.model,
      maxTokens: options.maxTokens,
      stream: options.stream,
      messageContent: options.messageContent,
      provider: inferProviderFromModel(options.model),
    })
  } catch (error) {
    if (error instanceof Error) {
      consola.warn(
        `Request admission failed before selection: ${JSON.stringify({
          path: c.req.path,
          model: options.model,
          routeKind: options.routeKind,
          maxTokens: options.maxTokens,
          stream: options.stream ?? false,
          errorName: error.name,
          errorMessage: error.message,
        })}`,
      )
    }
    throw error
  }

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
    endpoint: options.endpoint,
  })

  const target = selectRouteTarget(candidates)
  if (!target) {
    const diagnostic = diagnoseRouteFailure(options)
    const headers: Record<string, string> = {}
    if (diagnostic.retryAfterSeconds > 0) {
      headers["Retry-After"] = String(diagnostic.retryAfterSeconds)
    }
    throw new HTTPError(
      diagnostic.message,
      new Response(diagnostic.message, { status: 429, headers }),
    )
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  if (target.account) {
    return {
      kind: "account",
      account: target.account,
      target,
      initiator,
    }
  }

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
  return {
    kind: "provider",
    target,
    connection,
    credential: found.credential,
    initiator,
  }
}

type FailureReason = "disabled" | "cooldown" | "quota" | "auth" | "unknown"

interface RouteFailureDiagnostic {
  message: string
  retryAfterSeconds: number
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
    endpoint: options.endpoint,
    onlyAvailable: false,
  })

  if (allCandidates.length === 0) {
    return {
      message: `No available route for model "${options.model}": model is not configured or not supported by any enabled provider`,
      retryAfterSeconds: 0,
    }
  }

  const { reasons, retryAfterSeconds } = analyzeCandidateReasons(allCandidates)

  if (reasons.size === 0) {
    // All candidates report available, yet selectRouteTarget returned null.
    // This is defensive and should be rare.
    return {
      message: `No available route for model "${options.model}": all candidates were filtered out by routing rules`,
      retryAfterSeconds: 0,
    }
  }

  if (reasons.size === 1) {
    const reason = [...reasons][0]
    if (reason === "quota") {
      return {
        message: `No available route for model "${options.model}": quota exhausted for all providers`,
        retryAfterSeconds: 0,
      }
    }
    if (reason === "cooldown") {
      return {
        message: `No available route for model "${options.model}": all providers are temporarily rate-limited`,
        retryAfterSeconds,
      }
    }
    if (reason === "auth") {
      return {
        message: `No available route for model "${options.model}": authentication failed for all providers`,
        retryAfterSeconds: 0,
      }
    }
    if (reason === "disabled") {
      return {
        message: `No available route for model "${options.model}": all providers are disabled`,
        retryAfterSeconds: 0,
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
  }
}

function analyzeCandidateReasons(candidates: Array<RouteTarget>): {
  reasons: Set<FailureReason>
  retryAfterSeconds: number
} {
  const reasons = new Set<FailureReason>()
  let retryAfterSeconds = 0

  for (const candidate of candidates) {
    if (candidate.account) {
      const availability = getAccountAvailability(candidate.account)
      if (!availability.available) {
        const reason = mapAccountReason(availability.reason)
        reasons.add(reason)
        if (
          reason === "cooldown"
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
  if (
    reason === "cooldown"
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
 */
export function switchToNextRouteTarget(
  _current: RouteTarget,
  modelId: string,
  endpoint: ModelEndpoint,
  exclude: Set<string>,
): RouteTarget | null {
  const routing = resolveModelRouting(modelId)
  const candidates = buildRouteTargets({
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    endpoint,
  })
  return selectRouteTarget(candidates, { exclude })
}

/**
 * 把 RouteTarget 解析为 ProviderAdmission 或 null (Account target)。
 */
export function resolveConnectionFromTarget(target: RouteTarget): {
  connection: ProviderConnection
  credential: ApiCredential
} | null {
  const connection = getProviderConnection(target.connectionId)
  if (!connection) return null
  const found = findCredential(target.connectionId, target.credentialId)
  if (!found) return null
  return { connection, credential: found.credential }
}

/** Infer provider ID from model name (for guard auto-detection exemption). */
function inferProviderFromModel(model: string): string | undefined {
  const parsed = parseModelReference(model)
  if (parsed.provider) return parsed.provider
  // Check connection-level prefix
  const slashIdx = model.indexOf("/")
  if (slashIdx > 0) {
    const maybeConn = model.slice(0, slashIdx)
    const conn = getProviderConnection(maybeConn)
    if (conn) return conn.protocol === "copilot-native" ? "copilot" : maybeConn
  }
  return undefined
}
