import type { ProviderConnection } from "~/lib/provider-connections"
import type { RequestAdmission } from "~/lib/request-admission"
import type { RestDecision } from "~/lib/route-target"
import type { ClassifiedWsFailure } from "~/services/responses/ws-failure"

import {
  HTTPError,
  LocalConcurrencyLimitError,
  LocalPayloadUnsupportedError,
  LocalUnavailableError,
  UpstreamModelUnavailableError,
} from "~/lib/error"
import { createLogger } from "~/lib/logger"
import {
  DEFAULTS,
  classifyUpstreamError,
  getMutableProviderConnection,
  isAccountManagedConnection,
  markCredentialAuthError,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  persistProviderConnections,
  readConnectionMetadata,
  setConnectionAuthStatus,
  setConnectionCooldownUntil,
  setConnectionExhausted,
  setConnectionQuotaState,
  setConnectionRateLimitInfo,
} from "~/lib/provider-connections"
import {
  getRemainingCooldownSeconds,
  reportUpstreamRateLimit,
  reportUpstreamRateLimitMs,
} from "~/lib/rate-limit"
import {
  recordRest,
  restDecisionFor,
  restDecisionForReason,
  restReasonForErrorKind,
  targetKey,
} from "~/lib/route-target"
import { affinityAuthKey, invalidateSessionAffinityAuth } from "~/lib/routing"
import { getProtocolAdapter } from "~/services/protocols"
import { WindsurfUpstreamError } from "~/services/windsurf/error-classifier"

const logger = createLogger("dispatch")

interface AttemptFailureClassification {
  status?: number
  errorCode?: string
  retryAfterMs?: number
  errorSnippet?: string
  rest?: RestDecision
}

/**
 * Classify an error caught by the failover loop for attempt logging and
 * downstream rest/cooldown settlement.
 */
export function classifyAttemptFailure(
  error: unknown,
): AttemptFailureClassification {
  if (error instanceof UpstreamModelUnavailableError) {
    return {
      status: error.response.status,
      errorCode: "model_unavailable",
      errorSnippet: error.responseBody,
    }
  }
  if (error instanceof HTTPError) {
    if (error instanceof LocalConcurrencyLimitError) {
      return {
        status: error.response.status,
        errorCode: "concurrency_limit",
        errorSnippet: error.message,
      }
    }
    if (error instanceof LocalPayloadUnsupportedError) {
      return {
        status: error.response.status,
        errorCode: "semantic_unsupported",
        errorSnippet: error.message,
      }
    }
    if (error instanceof LocalUnavailableError) {
      return {
        status: error.response.status,
        errorCode: "local_unavailable",
        errorSnippet: error.message,
      }
    }
    const classified = classifyUpstreamError({
      status: error.response.status,
      headers: error.response.headers,
      body: error.responseBody,
    })
    return {
      status: error.response.status,
      errorCode: classified.kind,
      retryAfterMs: classified.retryAfterMs,
      errorSnippet: error.responseBody,
      rest: restDecisionFor({
        status: error.response.status,
        headers: error.response.headers,
        body: error.responseBody,
        fallbackMs:
          classified.retryAfterMs ?? DEFAULTS.COOLDOWN_429_FALLBACK_MS,
      }),
    }
  }
  if (error instanceof WindsurfUpstreamError) {
    return {
      errorCode: error.kind,
      retryAfterMs: error.retryAfterMs,
      errorSnippet: error.message,
      rest: restDecisionForReason({
        reason: restReasonForErrorKind(error.kind),
        retryAfterMs: error.retryAfterMs,
        fallbackMs: DEFAULTS.COOLDOWN_429_FALLBACK_MS,
      }),
    }
  }
  if (error instanceof Error) {
    return {
      errorCode: error.name,
      rest: restDecisionForReason({
        reason: "network",
        fallbackMs: DEFAULTS.COOLDOWN_NETWORK_MS,
      }),
    }
  }
  return {}
}

/**
 * Emit a structured warning for a failed upstream attempt before cooling down
 * or rotating to the next candidate.
 */
export function logAttemptFailure(
  logPrefix: string,
  admission: RequestAdmission,
  error: unknown,
): void {
  const target = targetKey(admission.target)
  if (error instanceof WindsurfUpstreamError) {
    logger.warn(
      `${logPrefix} Windsurf upstream error: ${JSON.stringify({
        target,
        kind: error.kind,
        code: error.code,
        retryAfterMs: error.retryAfterMs,
        message: error.message,
      })}`,
    )
    return
  }
  if (error instanceof HTTPError) {
    logger.warn(
      `${logPrefix} Request failed during execution: ${JSON.stringify({
        target,
        status: error.response.status,
        retryAfter: error.response.headers.get("Retry-After"),
        message: error.message,
      })}`,
    )
    return
  }
  logger.warn(
    `${logPrefix} Unexpected error during execution: ${JSON.stringify({
      target,
      error: error instanceof Error ? error.message : String(error),
    })}`,
  )
}

/**
 * True when the upstream rejected the prompt on content-policy grounds; the
 * caller should surface a 400 immediately without cooling the credential or
 * rotating to another candidate.
 */
export function toNonRetryableContentPolicyError(
  error: unknown,
): HTTPError | undefined {
  if (
    error instanceof WindsurfUpstreamError
    && error.kind === "content_policy"
  ) {
    return new HTTPError(
      error.message,
      new Response(null, { status: 400 }),
      error.message,
    )
  }
  return undefined
}

function syncConnectionExhaustedState(conn: ProviderConnection): void {
  const meta = readConnectionMetadata(conn)
  const remainingCooldown = getRemainingCooldownSeconds(conn.id)
  const exhausted = remainingCooldown > 0 || meta?.quotaState === "exhausted"
  if (!exhausted) {
    setConnectionExhausted(conn, false)
    return
  }
  setConnectionExhausted(
    conn,
    true,
    meta?.lastRateLimitAt ?? meta?.quotaExhaustedAt,
  )
}

async function persistConnectionState(
  logPrefix: string,
  what: string,
): Promise<void> {
  await persistProviderConnections().catch((err: unknown) => {
    logger.warn(
      `${logPrefix} failed to persist ${what}:`,
      (err as Error).message,
    )
  })
}

function applyConnectionRateLimitCooldown(
  conn: ProviderConnection,
  reason: string,
): void {
  const remainingCooldown = getRemainingCooldownSeconds(conn.id)
  setConnectionRateLimitInfo(conn, Date.now(), reason)
  setConnectionCooldownUntil(
    conn,
    remainingCooldown > 0 ? Date.now() + remainingCooldown * 1000 : undefined,
  )
  syncConnectionExhaustedState(conn)
}

async function markConnectionRateLimited(
  conn: ProviderConnection,
  status: number,
  logPrefix: string,
  retryAfterMs?: number,
): Promise<void> {
  await (retryAfterMs !== undefined ?
    reportUpstreamRateLimitMs(conn.id, retryAfterMs)
  : reportUpstreamRateLimit(conn.id, new Response(null, { status })))
  applyConnectionRateLimitCooldown(
    conn,
    status === 429 ? "upstream_429" : `upstream_${status}`,
  )
  await persistConnectionState(logPrefix, "connection rate-limit state")
  logger.warn(
    `Connection "${conn.name}" marked unavailable due to upstream rate limit`,
  )
}

async function markConnectionRateLimitedMs(
  conn: ProviderConnection,
  opts: { retryAfterMs?: number; reason: string; logPrefix: string },
): Promise<void> {
  await reportUpstreamRateLimitMs(conn.id, opts.retryAfterMs)
  applyConnectionRateLimitCooldown(conn, opts.reason)
  await persistConnectionState(opts.logPrefix, "connection rate-limit state")
  logger.warn(
    `Connection "${conn.name}" marked unavailable due to rate limit (${opts.reason})`,
  )
}

async function markAccountManagedQuotaExhausted(
  conn: ProviderConnection,
  cooldownMs: number,
  logPrefix: string,
  what = "connection quota state",
): Promise<void> {
  setConnectionQuotaState(conn, "exhausted")
  setConnectionCooldownUntil(conn, Date.now() + cooldownMs)
  syncConnectionExhaustedState(conn)
  await persistConnectionState(logPrefix, what)
}

async function markAccountManagedCooldown(
  conn: ProviderConnection,
  error: unknown,
  ctx: {
    status: number
    isHttp: boolean
    authKey: string
    logPrefix: string
    rest?: RestDecision
  },
): Promise<void> {
  const { status, isHttp, authKey, logPrefix, rest } = ctx
  if (error instanceof WindsurfUpstreamError) {
    if (error.kind === "quota_exhausted") {
      invalidateSessionAffinityAuth(authKey)
      await markAccountManagedQuotaExhausted(
        conn,
        error.retryAfterMs ?? DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS,
        logPrefix,
      )
      return
    }
    if (error.kind === "auth_error") {
      invalidateSessionAffinityAuth(authKey)
      setConnectionAuthStatus(conn, "error", error.message)
      syncConnectionExhaustedState(conn)
      await persistConnectionState(logPrefix, "connection auth error state")
      return
    }
    invalidateSessionAffinityAuth(authKey)
    await markConnectionRateLimitedMs(conn, {
      retryAfterMs: error.retryAfterMs,
      reason: `upstream_windsurf_${error.kind}`,
      logPrefix,
    })
    return
  }

  if (isHttp && error instanceof HTTPError) {
    const classified = classifyUpstreamError({
      status,
      headers: error.response.headers,
      body: error.responseBody,
    })
    if (rest?.reason === "credit") {
      invalidateSessionAffinityAuth(authKey)
      await markAccountManagedQuotaExhausted(
        conn,
        rest.restMs,
        logPrefix,
        "connection credit state",
      )
      return
    }
    if (rest?.reason === "verify") {
      invalidateSessionAffinityAuth(authKey)
      await markConnectionRateLimitedMs(conn, {
        retryAfterMs: rest.restMs,
        reason: "upstream_verify",
        logPrefix,
      })
      return
    }
    if (error.responseBody && classified.kind === "quota_exhausted") {
      invalidateSessionAffinityAuth(authKey)
      const cooldownMs =
        rest?.reason === "quota" ?
          rest.restMs
        : (classified.retryAfterMs ?? DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS)
      await markAccountManagedQuotaExhausted(conn, cooldownMs, logPrefix)
      return
    }
    // An account-managed connection has exactly one credential, so an
    // auth_error is the connection's own state: without this branch the 401
    // merely looked like a rate limit (or nothing at all) and the account kept
    // being selected until an operator noticed.
    if (classified.kind === "auth_error") {
      invalidateSessionAffinityAuth(authKey)
      setConnectionAuthStatus(
        conn,
        "error",
        `HTTP ${status}: ${(error.responseBody ?? "").slice(0, 200)}`,
      )
      syncConnectionExhaustedState(conn)
      await persistConnectionState(logPrefix, "connection auth error state")
      return
    }
    if (status === 429) {
      invalidateSessionAffinityAuth(authKey)
      await markConnectionRateLimited(
        conn,
        status,
        logPrefix,
        rest?.reason === "rate" ? rest.restMs : classified.retryAfterMs,
      )
      return
    }
  }

  if (!isHttp) {
    invalidateSessionAffinityAuth(authKey)
    await markConnectionRateLimited(conn, status, logPrefix)
  }
}

/**
 * Apply connection cooldown / quota / auth state from an already-classified WS
 * `response.create` failure (credential scope).
 */
export async function recordUpstreamFailure(
  admission: RequestAdmission,
  failure: ClassifiedWsFailure,
  logPrefix = "[ws-failover]",
): Promise<void> {
  const authKey = affinityAuthKey(admission.target)
  invalidateSessionAffinityAuth(authKey)

  const conn =
    isAccountManagedConnection(admission.connection) ?
      getMutableProviderConnection(admission.connection.id)
    : undefined

  if (conn) {
    switch (failure.kind) {
      case "quota": {
        await markAccountManagedQuotaExhausted(
          conn,
          failure.retryAfterMs ?? DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS,
          logPrefix,
        )
        return
      }
      case "auth": {
        setConnectionAuthStatus(
          conn,
          "error",
          `upstream ws auth error${
            failure.status ? ` (HTTP ${failure.status})` : ""
          }`,
        )
        syncConnectionExhaustedState(conn)
        await persistConnectionState(logPrefix, "connection auth state")
        return
      }
      case "rate":
      case "server": {
        const cooldownMs =
          failure.retryAfterMs
          ?? (failure.kind === "server" ?
            DEFAULTS.COOLDOWN_5XX_MS
          : DEFAULTS.COOLDOWN_429_FALLBACK_MS)
        await markConnectionRateLimitedMs(conn, {
          retryAfterMs: cooldownMs,
          reason: `upstream_ws_${failure.kind}`,
          logPrefix,
        })
        return
      }
      default: {
        return
      }
    }
  }

  if (failure.kind === "quota") {
    markCredentialQuotaExhausted(
      admission.credential,
      "upstream ws quota exhausted",
      failure.retryAfterMs,
    )
  } else {
    markCredentialCooldown(admission.credential, {
      retryAfterMs:
        failure.retryAfterMs
        ?? (failure.kind === "server" ?
          DEFAULTS.COOLDOWN_5XX_MS
        : DEFAULTS.COOLDOWN_429_FALLBACK_MS),
      reason: `upstream ws ${failure.kind}`,
    })
  }
  await persistConnectionState(logPrefix, "credential status")
}

export async function markCooldown(
  admission: RequestAdmission,
  error: unknown,
  logPrefix: string,
  rest?: RestDecision,
): Promise<void> {
  // The adapter already recorded a model-only cooldown. The credential is healthy.
  if (error instanceof UpstreamModelUnavailableError) return
  const adapter = getProtocolAdapter(admission.connection.protocol)
  if (
    error instanceof HTTPError
    && adapter?.recordModelRateLimit?.({
      connection: admission.connection,
      credential: admission.credential,
      model: admission.target.upstreamModelId,
      status: error.response.status,
      body: error.responseBody,
    })
  ) {
    return
  }

  const isHttp = error instanceof HTTPError
  const status = isHttp ? error.response.status : 503
  const authKey = affinityAuthKey(admission.target)
  const modelCreditRefusal =
    rest?.reason === "credit"
    && Boolean(
      adapter?.isModelCreditExempt?.(
        admission.connection,
        admission.target.upstreamModelId,
      ),
    )

  const requestFault = isHttp && rest?.reason === "unknown"
  if (rest && !requestFault) {
    recordRest({
      credentialId: admission.credential.id,
      credentialCreatedAt: admission.credential.createdAt,
      ...(modelCreditRefusal && { model: admission.target.upstreamModelId }),
      reason: rest.reason,
      by: rest.by,
      untilMs: rest.restMs > 0 ? rest.untilMs : 0,
      said: isHttp ? (error.responseBody ?? undefined) : undefined,
    })
  }
  if (modelCreditRefusal) return

  if (rest?.reason === "refused") {
    admission.credential.lastError = "upstream refused"
    admission.credential.lastErrorAt = Date.now()
    await persistConnectionState(logPrefix, "credential status")
    return
  }

  if (isAccountManagedConnection(admission.connection)) {
    const conn = getMutableProviderConnection(admission.connection.id)
    if (conn) {
      await markAccountManagedCooldown(conn, error, {
        status,
        isHttp,
        authKey,
        logPrefix,
        rest,
      })
    }
    return
  }

  invalidateSessionAffinityAuth(authKey)
  let classified: ReturnType<typeof classifyUpstreamError> | undefined
  const errorBody = isHttp ? error.responseBody : undefined
  const shortReason =
    isHttp ?
      `upstream ${status}: ${(errorBody ?? "").slice(0, 200)}`
    : `upstream ${status}`
  if (isHttp) {
    classified = classifyUpstreamError({
      status,
      headers: error.response.headers,
      body: errorBody,
    })
    if (rest?.reason === "credit") {
      markCredentialQuotaExhausted(
        admission.credential,
        shortReason,
        rest.restMs,
      )
      await persistConnectionState(logPrefix, "credential status")
      return
    }
    if (rest?.reason === "verify") {
      markCredentialCooldown(admission.credential, {
        retryAfterMs: rest.restMs,
        reason: `upstream verify: ${shortReason}`,
      })
      await persistConnectionState(logPrefix, "credential status")
      return
    }
    if (classified.kind === "quota_exhausted") {
      markCredentialQuotaExhausted(
        admission.credential,
        shortReason,
        rest?.reason === "quota" ? rest.restMs : classified.retryAfterMs,
      )
      await persistConnectionState(logPrefix, "credential status")
      return
    }
    if (classified.kind === "auth_error") {
      markCredentialAuthError(admission.credential, shortReason)
      await persistConnectionState(logPrefix, "credential status")
      return
    }
    if (classified.kind === "client_error" || classified.kind === "unknown") {
      admission.credential.lastError = shortReason
      admission.credential.lastErrorAt = Date.now()
      await persistConnectionState(logPrefix, "credential status")
      return
    }
  }
  const retryAfterMs =
    rest?.reason === "rate" ?
      rest.restMs
    : (classified?.retryAfterMs ?? resolveRetryAfterMs(isHttp, status))
  const errorCode =
    isHttp ? extractUpstreamErrorCode(error.responseBody) : undefined
  const reason =
    isHttp ?
      errorCode ? `upstream ${status}: ${errorCode}`
      : `upstream ${status}`
    : resolveNetworkError(error)
  markCredentialCooldown(admission.credential, { retryAfterMs, reason })
  await persistConnectionState(logPrefix, "credential status")
}

function resolveRetryAfterMs(isHttp: boolean, status: number): number {
  if (!isHttp) return DEFAULTS.COOLDOWN_NETWORK_MS
  if (status === 429) return DEFAULTS.COOLDOWN_429_FALLBACK_MS
  return DEFAULTS.COOLDOWN_5XX_MS
}

function extractUpstreamErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string | number; type?: string }
    }
    const code = parsed.error?.code ?? parsed.error?.type
    return code === undefined ? undefined : String(code)
  } catch {
    return undefined
  }
}

function resolveNetworkError(error: unknown): string {
  if (error instanceof Error) return error.message
  return "network error"
}
