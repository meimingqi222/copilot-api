import type { RouteCandidate, RouteCandidateStatus } from "~/lib/log-store"
import type {
  ModelEndpoint,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"

import {
  connectionProvider,
  getConnectionRoutability,
  getProviderConnection,
  isAccountManagedConnection,
  isCredentialAvailable,
  refreshConnectionAvailability,
} from "~/lib/provider-connections"
import {
  buildRouteTargetsForRouting,
  resolveModelRouting,
  routeEvidenceFor,
  targetKey,
} from "~/lib/route-target"

// Availability diagnostics and trace projection only; selection and HTTP/log
// publication belong to admission. Availability reads retain runtime refreshes.
interface RouteDiagnosticOptions {
  model: string
  endpoint: ModelEndpoint
  compact?: boolean
}

export type FailureReason =
  | "disabled"
  | "cooldown"
  | "quota"
  | "auth"
  | "unknown"

export interface RouteFailureDiagnostic {
  message: string
  retryAfterSeconds: number
  /**
   * 主因:用于构造客户端可识别的 error.type / error.code。
   * 混合原因下取最严重的(quota > auth > cooldown > disabled > unknown)。
   */
  reason: FailureReason
}

export function diagnoseRouteFailure(
  options: RouteDiagnosticOptions,
  model: string,
): RouteFailureDiagnostic {
  const routing = resolveModelRouting(model)
  // Name the model routing actually worked with, and the group reference it
  // came from, so a group whose member is unroutable says which member failed.
  const label =
    model === options.model ?
      `"${model}"`
    : `"${model}" (routing group ${options.model})`
  const allCandidates = buildRouteTargetsForRouting(routing, {
    endpoint: options.endpoint,
    onlyAvailable: false,
    compact: options.compact,
  })

  if (allCandidates.length === 0) {
    return {
      message: `No available route for model ${label}: model is not configured or not supported by any enabled provider`,
      retryAfterSeconds: 0,
      reason: "unknown",
    }
  }

  const { reasons, retryAfterSeconds } = analyzeCandidateReasons(allCandidates)

  if (reasons.size === 0) {
    // All candidates report available, yet selectRouteTarget returned null.
    // This is defensive and should be rare.
    return {
      message: `No available route for model ${label}: all candidates were filtered out by routing rules`,
      retryAfterSeconds: 0,
      reason: "unknown",
    }
  }

  const dominantReason = pickDominantFailureReason(reasons)

  if (reasons.size === 1) {
    const reason = [...reasons][0]
    if (reason === "quota") {
      return {
        message: `No available route for model ${label}: quota exhausted for all providers`,
        retryAfterSeconds,
        reason: dominantReason,
      }
    }
    if (reason === "cooldown") {
      return {
        message: `No available route for model ${label}: all providers are temporarily rate-limited`,
        retryAfterSeconds,
        reason: dominantReason,
      }
    }
    if (reason === "auth") {
      return {
        message: `No available route for model ${label}: authentication failed for all providers`,
        retryAfterSeconds: 0,
        reason: dominantReason,
      }
    }
    if (reason === "disabled") {
      return {
        message: `No available route for model ${label}: all providers are disabled`,
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
    message: `No available route for model ${label}: all providers are unavailable (${reasonLabels})`,
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

export function analyzeCandidateReasons(candidates: Array<RouteTarget>): {
  reasons: Set<FailureReason>
  retryAfterSeconds: number
} {
  const reasons = new Set<FailureReason>()
  let retryAfterSeconds = Infinity

  for (const candidate of candidates) {
    const conn = getProviderConnection(candidate.connectionId)
    const availability =
      conn && isAccountManagedConnection(conn) ?
        getConnectionAvailability(conn, candidate.upstreamModelId)
      : undefined
    const credentialDiagnostic = getCredentialFailureDiagnostic(
      candidate.connectionId,
      candidate.credentialId,
    )
    if (
      credentialDiagnostic?.reason === "disabled"
      || credentialDiagnostic?.reason === "auth"
    ) {
      reasons.add(credentialDiagnostic.reason)
      continue
    }
    const diagnostic =
      availability && !availability.available ?
        {
          reason: mapAccountReason(availability.reason),
          retryAfterSeconds: Math.max(
            availability.retryAfterSeconds,
            credentialDiagnostic?.retryAfterSeconds ?? 0,
          ),
        }
      : credentialDiagnostic
    if (!diagnostic) continue
    reasons.add(diagnostic.reason)
    // One recovered route is enough; a spent account must not extend a backup's wait.
    if (
      (diagnostic.reason === "cooldown" || diagnostic.reason === "quota")
      && diagnostic.retryAfterSeconds > 0
    ) {
      retryAfterSeconds = Math.min(
        retryAfterSeconds,
        diagnostic.retryAfterSeconds,
      )
    }
  }

  return {
    reasons,
    retryAfterSeconds:
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 0,
  }
}

/**
 * Describe every route the gateway could have taken, chosen one first.
 *
 * Built from the *unfiltered* candidate pool so candidates that were skipped
 * for being unavailable still show up (the alternates stay
 * visible with why they lost). One row per connection/credential, preferring
 * the native endpoint, mirroring how the pool is shaped before selection.
 */
export function describeCandidates(
  allCandidates: Array<RouteTarget>,
  chosen: RouteTarget,
  limit = 12,
): Array<RouteCandidate> {
  const byKey = new Map<string, RouteTarget>()
  for (const candidate of allCandidates) {
    const model = candidate.upstreamModelId || candidate.publicModelId || ""
    const key = `${candidate.connectionId}::${candidate.credentialId}::${model}`
    const previous = byKey.get(key)
    if (!previous || (previous.isTranslated && !candidate.isTranslated)) {
      byKey.set(key, candidate)
    }
  }

  const rows: Array<RouteCandidate> = []
  for (const [, candidate] of byKey) {
    const connection = getProviderConnection(candidate.connectionId)
    const credential = connection?.credentials.find(
      (c) => c.id === candidate.credentialId,
    )
    let status: RouteCandidateStatus
    let retryAfterMs: number | undefined

    const isChosen =
      targetKey(candidate) === targetKey(chosen)
      && candidate.upstreamModelId === chosen.upstreamModelId
    if (isChosen) {
      status = "chosen"
    } else if (connection && isAccountManagedConnection(connection)) {
      const availability = getConnectionAvailability(
        connection,
        candidate.upstreamModelId,
      )
      if (!availability.available) {
        status = mapAccountReason(availability.reason)
      } else {
        status = candidateAvailability(candidate)
      }
      if (availability.retryAfterSeconds > 0) {
        retryAfterMs = availability.retryAfterSeconds * 1000
      }
    } else {
      const diagnostic = getCredentialFailureDiagnostic(
        candidate.connectionId,
        candidate.credentialId,
      )
      if (diagnostic && diagnostic.reason !== "disabled") {
        status = diagnostic.reason
        if (diagnostic.retryAfterSeconds > 0) {
          retryAfterMs = diagnostic.retryAfterSeconds * 1000
        }
      } else if (connection && !connection.enabled) {
        status = "disabled"
      } else {
        status = candidateAvailability(candidate)
      }
    }

    const evidence =
      candidate.credentialId ?
        routeEvidenceFor(
          candidate.connectionId,
          candidate.credentialId,
          candidate.upstreamModelId,
        )
      : undefined

    // A model-specific refusal still applies even when balance is exempt.
    if (
      !isChosen
      && evidence?.rest?.untilMs
      && evidence.rest.untilMs > Date.now()
      && ["available", "translated", "wildcard"].includes(status)
    ) {
      switch (evidence.rest.reason) {
        case "credit":
        case "quota":
          status = "quota"
          break
        case "verify":
          status = "auth"
          break
        case "disabled":
          status = "disabled"
          break
        default:
          status = "cooldown"
      }
      retryAfterMs = evidence.rest.untilMs - Date.now()
    }

    rows.push({
      connectionId: candidate.connectionId,
      connectionName: connection?.name ?? candidate.connectionName,
      provider: connection ? connectionProvider(connection) : undefined,
      credentialId: candidate.credentialId,
      credentialLabel: credential?.label,
      protocol: candidate.protocol,
      endpoint: candidate.endpoint,
      model: candidate.upstreamModelId || candidate.publicModelId,
      priority: candidate.connectionPriority,
      status,
      retryAfterMs,
      why:
        isChosen ? "chosen" : (
          (evidence?.rest?.reason
          ?? (status === "available" ? "backup" : status))
        ),
      quotaUsedPct:
        evidence?.quota?.usedFraction === undefined ?
          undefined
        : Math.round(evidence.quota.usedFraction * 1000) / 10,
      renewAtMs: evidence?.quota?.renewsAtMs[0],
      servedTokens: evidence ? Math.round(evidence.servedTokens) : undefined,
      restReason: evidence?.rest?.reason,
      restUntilMs: evidence?.rest?.untilMs,
    })
  }

  const rank: Record<RouteCandidateStatus, number> = {
    chosen: 0,
    available: 1,
    translated: 2,
    wildcard: 3,
    cooldown: 4,
    quota: 5,
    auth: 6,
    disabled: 7,
    unknown: 8,
  }
  rows.sort(
    (a, b) =>
      rank[a.status] - rank[b.status]
      || (a.priority ?? 99) - (b.priority ?? 99),
  )
  return rows.slice(0, limit)
}

/** Why an otherwise-available candidate was not the one picked. */
function candidateAvailability(candidate: RouteTarget): RouteCandidateStatus {
  if (candidate.isWildcard) return "wildcard"
  if (candidate.isTranslated) return "translated"
  return "available"
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
  if (!credential.enabled) {
    return { reason: "disabled", retryAfterSeconds: 0 }
  }

  // Credential is available — no failure to report. This happens because
  // buildRouteTargets is called with onlyAvailable: false for diagnosis,
  // so the candidate list includes both available and unavailable entries.
  if (isCredentialAvailable(credential)) {
    return null
  }

  // Account-managed HTTP 5xx failures rest in memory while status stays ready.
  const rest = routeEvidenceFor(connectionId, credentialId).rest
  const reason =
    credential.status !== "ready" ? mapCredentialReason(credential.status)
    : rest?.reason === "quota" || rest?.reason === "credit" ? "quota"
    : rest?.reason === "verify" ? "auth"
    : rest?.reason === "disabled" ? "disabled"
    : "cooldown"
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
  if (rest?.untilMs && rest.untilMs > Date.now()) {
    retryAfterSeconds = Math.max(
      retryAfterSeconds,
      Math.ceil((rest.untilMs - Date.now()) / 1000),
    )
  }
  return { reason, retryAfterSeconds }
}

/**
 * 从 connection 字段直接判断可用性（替代 getAccount + getAccountAvailability）。
 * 仅用于 account-managed connection 的失败诊断。调度语义委托统一定义
 * getConnectionRoutability,此处仅做原因词汇映射(对外保持原 reason 集合)。
 */
function getConnectionAvailability(
  conn: ProviderConnection,
  modelId?: string,
): {
  available: boolean
  reason: "available" | "disabled" | "cooldown" | "quota" | "error"
  retryAfterSeconds: number
} {
  // 先刷新过期的 cooldown / quota_exhausted 状态（等价于 refreshAccountRuntimeAvailability）
  refreshConnectionAvailability(conn)

  const routability = getConnectionRoutability(conn, modelId)
  if (routability.routable) {
    return { available: true, reason: "available", retryAfterSeconds: 0 }
  }
  switch (routability.reason) {
    case "auth_error": {
      return {
        available: false,
        reason: "error",
        retryAfterSeconds: routability.retryAfterSeconds,
      }
    }
    case "quota_exhausted": {
      return {
        available: false,
        reason: "quota",
        retryAfterSeconds: routability.retryAfterSeconds,
      }
    }
    case "cooldown": {
      return {
        available: false,
        reason: "cooldown",
        retryAfterSeconds: routability.retryAfterSeconds,
      }
    }
    case "disabled":
    case "available": {
      return {
        available: false,
        reason: "disabled",
        retryAfterSeconds: 0,
      }
    }
    default: {
      // 未知原因一律按不可用处理(fail-safe)。
      return {
        available: false,
        reason: "disabled",
        retryAfterSeconds: 0,
      }
    }
  }
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
