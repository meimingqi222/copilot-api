import type { Context } from "hono"

import type {
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ClassifiedWsFailure } from "~/services/responses/ws-failure"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  DEFAULTS,
  classifyUpstreamError,
  connectionProvider,
  getMutableProviderConnection,
  isAccountManagedConnection,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  persistProviderConnections,
  readAccountLegacyMetadata,
  setConnectionAuthStatus,
  setConnectionCooldownUntil,
  setConnectionExhausted,
  setConnectionQuotaState,
  setConnectionRateLimitInfo,
} from "~/lib/provider-connections"
import {
  checkRateLimit,
  getRemainingCooldownSeconds,
  RateLimitQueueFullError,
  reportUpstreamRateLimit,
  reportUpstreamRateLimitMs,
  reportUpstreamSuccess,
} from "~/lib/rate-limit"
import { type RequestAdmission } from "~/lib/request-admission"
import { recordUpstreamAttempt } from "~/lib/request-log"
import {
  resolveConnectionFromTarget,
  switchToNextRouteTarget,
  targetKey,
} from "~/lib/route-target"
import { affinityAuthKey, invalidateSessionAffinityAuth } from "~/lib/routing"
import { isAbortError, safeOrigin, shouldFailover } from "~/lib/utils"
import {
  CredentialConcurrencyLimitError,
  isAsyncIterable,
  tryAcquireCredentialLease,
  wrapLeaseStream,
} from "~/services/dispatch/concurrency"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"
import { WindsurfConcurrencyLimitError } from "~/services/windsurf/concurrency"
import { WindsurfUpstreamError } from "~/services/windsurf/error-classifier"

export interface FailoverOptions<TPayload, TResult> {
  payload: TPayload
  admission: RequestAdmission
  signal?: AbortSignal
  routeKind: "chat" | "messages" | "responses" | "embeddings"
  execute: (
    adapter: ReturnType<typeof getProtocolAdapter>,
    target: RouteTarget,
    current: RequestAdmission,
  ) => Promise<TResult>
  logPrefix?: string
  c?: Context
}

export async function executeWithFailover<
  TPayload extends { model: string },
  TResult,
>(options: FailoverOptions<TPayload, TResult>): Promise<TResult> {
  const {
    payload,
    admission,
    routeKind,
    execute,
    logPrefix = "[dispatch]",
    c,
    signal,
  } = options
  initializeProtocolAdapters()

  const tried = new Set<string>()
  let current: RequestAdmission = admission

  const advanceToNextTarget = (): boolean => {
    const next = switchToNextRouteTarget(
      current.target,
      payload.model,
      routeKind,
      tried,
      {
        sessionId: current.sessionId,
        fallbackSessionId: current.fallbackSessionId,
      },
    )
    if (!next) return false
    const resolved = resolveConnectionFromTarget(next)
    if (!resolved) return false
    current = {
      target: next,
      connection: resolved.connection,
      credential: resolved.credential,
      initiator: current.initiator,
      // Keep L0 session binding context so subsequent failovers rebind
      // the same conversation to the newly selected credential.
      sessionId: current.sessionId,
      fallbackSessionId: current.fallbackSessionId,
    }
    return true
  }

  let attemptIndex = 0
  while (true) {
    const adapter = getProtocolAdapter(current.target.protocol)
    const attemptStart = Date.now()
    try {
      // Pacing gate (burst + interval per connection). Runs before lease
      // acquisition so waiting requests don't hold credential leases.
      // Queue-full is local saturation, not an upstream failure — it is
      // handled in the catch block by rotating without any cooldown.
      await checkRateLimit(current.connection.id, signal)
      const lease = tryAcquireCredentialLease(current.target)
      if (!lease) {
        throw new CredentialConcurrencyLimitError(
          `credential ${targetKey(current.target)} at in-flight cap`,
        )
      }
      let handedOffToStream = false
      try {
        const result = await execute(adapter, current.target, current)
        // Upstream accepted the request: clear any 429 backoff pressure so
        // the next 429 episode starts from the base backoff again.
        await reportUpstreamSuccess(current.connection.id)
        recordUpstreamAttempt(
          c,
          {
            ...current.target,
            connectionName: current.connection.name,
            credentialLabel: current.credential.label,
            provider: connectionProvider(current.connection),
            upstreamBaseUrl: safeOrigin(current.connection.baseUrl),
          },
          { status: 200, latencyMs: Date.now() - attemptStart },
          ++attemptIndex,
        )
        if (isAsyncIterable(result)) {
          // Hold the lease for the full stream lifetime, not until the
          // iterable is returned.
          handedOffToStream = true
          return wrapLeaseStream(result, lease) as TResult
        }
        return result
      } finally {
        if (!handedOffToStream) lease.release()
      }
    } catch (error) {
      if (error instanceof RateLimitQueueFullError) {
        // Local pacing saturation, not an upstream failure: rotate to the
        // next target without cooling anything down. Only when no target is
        // left do we surface a 429 (retryable) instead of a 500.
        tried.add(targetKey(current.target))
        logger.warn(
          `${logPrefix} pacing queue full for connection "${current.connection.name}", rotating to next target`,
        )
        if (advanceToNextTarget()) continue
        throw new HTTPError(
          "Rate limiter queue is full",
          new Response(null, { status: 429 }),
        )
      }
      if (isAbortError(error)) throw error

      const latencyMs = Date.now() - attemptStart
      const idx = ++attemptIndex
      let errorCode: string | undefined
      let retryAfterMs: number | undefined
      let errorSnippet: string | undefined
      if (error instanceof HTTPError) {
        const classified = classifyUpstreamError({
          status: error.response.status,
          headers: error.response.headers,
          body: error.responseBody,
        })
        errorCode = classified.kind
        retryAfterMs = classified.retryAfterMs
        errorSnippet = error.responseBody
      } else if (error instanceof WindsurfUpstreamError) {
        errorCode = error.kind
        retryAfterMs = error.retryAfterMs
        errorSnippet = error.message
      } else if (error instanceof Error) {
        errorCode = error.name
      }
      recordUpstreamAttempt(
        c,
        {
          ...current.target,
          connectionName: current.connection.name,
          credentialLabel: current.credential.label,
          provider: connectionProvider(current.connection),
          upstreamBaseUrl: safeOrigin(current.connection.baseUrl),
        },
        {
          status:
            error instanceof HTTPError ? error.response.status : undefined,
          latencyMs,
          errorCode,
          retryAfterMs,
          errorSnippet,
        },
        idx,
      )
      tried.add(targetKey(current.target))

      if (
        error instanceof HTTPError
        && !(error instanceof WindsurfConcurrencyLimitError)
        && !shouldFailover(error)
      ) {
        await markCooldown(current, error, logPrefix)
        throw error
      }

      // 添加详细的错误日志记录
      if (error instanceof WindsurfUpstreamError) {
        logger.warn(
          `${logPrefix} Windsurf upstream error: ${JSON.stringify({
            target: targetKey(current.target),
            kind: error.kind,
            code: error.code,
            retryAfterMs: error.retryAfterMs,
            message: error.message,
          })}`,
        )
      } else if (error instanceof HTTPError) {
        logger.warn(
          `${logPrefix} Request failed during execution: ${JSON.stringify({
            target: targetKey(current.target),
            status: error.response.status,
            retryAfter: error.response.headers.get("Retry-After"),
            message: error.message,
          })}`,
        )
      } else {
        logger.warn(
          `${logPrefix} Unexpected error during execution: ${JSON.stringify({
            target: targetKey(current.target),
            error: error instanceof Error ? error.message : String(error),
          })}`,
        )
      }

      // A local per-account / per-credential concurrency rejection is not an
      // upstream failure: do not cool down or mark the account. It is safe to
      // try another route target, while preserving the 429 if no target is
      // available.
      if (
        !(error instanceof WindsurfConcurrencyLimitError)
        && !(error instanceof CredentialConcurrencyLimitError)
      ) {
        await markCooldown(current, error, logPrefix)
      }

      if (!advanceToNextTarget()) throw error
    }
  }
}

/**
 * 通过 id 获取 stateRoot.connections 中的可变 connection 引用
 * (getMutableProviderConnection),冷却/配额写回直接落在其上。
 */
function resolveStateConnection(id: string) {
  return getMutableProviderConnection(id)
}

/** syncLegacyExhaustedState 的 connection 级镜像。 */
function syncConnectionExhaustedState(conn: ProviderConnection): void {
  const meta = readAccountLegacyMetadata(conn)
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
  // Prefer the real upstream retry hint when the caller classified one;
  // otherwise fall back to the adaptive backoff from the status alone.
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

/**
 * Phase 1:对 account-managed connection 直接执行冷却/配额/鉴权错误标记。
 * 原 Account 版本 mutate Account → syncAccountToConnection → saveAccounts;
 * 现在通过 connection 写入器直接落在 ProviderConnection 上。
 */
async function markAccountManagedCooldown(
  conn: ProviderConnection,
  error: unknown,
  ctx: {
    status: number
    isHttp: boolean
    authKey: string
    logPrefix: string
  },
): Promise<void> {
  const { status, isHttp, authKey, logPrefix } = ctx
  // Windsurf in-stream / HTTP error frames carry the parsed kind +
  // retryAfterMs (e.g. "Resets in: 3h0m0s" → 10800000ms). Apply the real
  // cooldown instead of the default 60s exponential backoff.
  if (error instanceof WindsurfUpstreamError) {
    if (error.kind === "quota_exhausted") {
      invalidateSessionAffinityAuth(authKey)
      setConnectionQuotaState(conn, "exhausted")
      setConnectionCooldownUntil(
        conn,
        error.retryAfterMs ?
          Date.now() + error.retryAfterMs
        : Date.now() + DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS,
      )
      syncConnectionExhaustedState(conn)
      await persistConnectionState(logPrefix, "connection quota state")
      return
    }
    if (error.kind === "auth_error") {
      invalidateSessionAffinityAuth(authKey)
      setConnectionAuthStatus(conn, "error", error.message)
      syncConnectionExhaustedState(conn)
      await persistConnectionState(logPrefix, "connection auth error state")
      return
    }
    // rate_limited / server_error → rate-limit cooldown
    // with the real upstream retryAfterMs (up to 4h for windsurf).
    invalidateSessionAffinityAuth(authKey)
    await markConnectionRateLimitedMs(conn, {
      retryAfterMs: error.retryAfterMs,
      reason: `upstream_windsurf_${error.kind}`,
      logPrefix,
    })
    return
  }

  if (isHttp && error instanceof HTTPError) {
    // Classify once (headers + body) and reuse: the quota check and the
    // 429 cooldown below must see the same retryAfterMs. Header-only 429s
    // (empty body) previously fell through to a synthetic Response and lost
    // the real Retry-After hint.
    const classified = classifyUpstreamError({
      status,
      headers: error.response.headers,
      body: error.responseBody,
    })
    if (error.responseBody && classified.kind === "quota_exhausted") {
      invalidateSessionAffinityAuth(authKey)
      setConnectionQuotaState(conn, "exhausted")
      setConnectionCooldownUntil(
        conn,
        classified.retryAfterMs ?
          Date.now() + classified.retryAfterMs
        : Date.now() + DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS,
      )
      syncConnectionExhaustedState(conn)
      await persistConnectionState(logPrefix, "connection quota state")
      return
    }
    if (status === 429) {
      invalidateSessionAffinityAuth(authKey)
      await markConnectionRateLimited(
        conn,
        status,
        logPrefix,
        classified.retryAfterMs,
      )
      return
    }
  }

  // HTTP 429 已在上面按真实 Retry-After 冷却;这里只处理网络错误。
  // 5xx 不冷却 connection、不打散 affinity。
  if (!isHttp) {
    invalidateSessionAffinityAuth(authKey)
    await markConnectionRateLimited(conn, status, logPrefix)
  }
}

/**
 * Apply connection cooldown / quota / auth state from an already-classified WS
 * `response.create` failure (credential scope). Unlike the private markCooldown
 * (which re-derives everything from HTTP heuristics), the scope/kind here is
 * authoritative — quota is quota, 5xx is cooled, 401/403 is auth.
 *
 * Phase 1:直接通过 connection 写入器落在 ProviderConnection +
 * AccountLegacyMetadata 上,使下一次 availability 检查
 * (isAccountAvailable / isConnectionAvailable)看到不可用状态。
 *
 * WS rotation is account-managed only, so this targets account-managed
 * connections; plain connections fall back to a direct credential cooldown.
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
      resolveStateConnection(admission.connection.id)
    : undefined

  if (conn) {
    switch (failure.kind) {
      case "quota": {
        setConnectionQuotaState(conn, "exhausted")
        setConnectionCooldownUntil(
          conn,
          failure.retryAfterMs ?
            Date.now() + failure.retryAfterMs
          : Date.now() + DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS,
        )
        syncConnectionExhaustedState(conn)
        await persistConnectionState(logPrefix, "connection quota state")
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

  // No account-backed connection: cool the credential directly.
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
  await persistProviderConnections().catch((err: unknown) => {
    logger.warn(
      `${logPrefix} failed to persist credential status:`,
      (err as Error).message,
    )
  })
}

async function markCooldown(
  admission: RequestAdmission,
  error: unknown,
  logPrefix: string,
): Promise<void> {
  const isHttp = error instanceof HTTPError
  const status = isHttp ? error.response.status : 503
  const authKey = affinityAuthKey(admission.target)

  // account-managed 路径:直接写回 ProviderConnection + 持久化
  if (isAccountManagedConnection(admission.connection)) {
    const conn = resolveStateConnection(admission.connection.id)
    if (conn) {
      await markAccountManagedCooldown(conn, error, {
        status,
        isHttp,
        authKey,
        logPrefix,
      })
    }
    return
  }

  // 纯 provider 路径:标记 credential cooldown / quota_exhausted
  invalidateSessionAffinityAuth(authKey)
  let classified: ReturnType<typeof classifyUpstreamError> | undefined
  if (isHttp && error.responseBody) {
    // Use classifyUpstreamError for accurate categorization, especially
    // for Codex usage_limit_reached which needs quota_exhausted treatment.
    classified = classifyUpstreamError({
      status,
      headers: error.response.headers,
      body: error.responseBody,
    })
    if (classified.kind === "quota_exhausted") {
      markCredentialQuotaExhausted(
        admission.credential,
        `upstream ${status}: ${error.responseBody.slice(0, 200)}`,
        classified.retryAfterMs,
      )
      await persistProviderConnections().catch((err: unknown) => {
        logger.warn(
          `${logPrefix} failed to persist credential status:`,
          (err as Error).message,
        )
      })
      return
    }
  }
  const retryAfterMs =
    classified?.retryAfterMs ?? resolveRetryAfterMs(isHttp, status)
  const errorCode =
    isHttp ? extractUpstreamErrorCode(error.responseBody) : undefined
  let reason: string
  if (isHttp) {
    reason =
      errorCode ? `upstream ${status}: ${errorCode}` : `upstream ${status}`
  } else {
    reason = resolveNetworkError(error)
  }
  markCredentialCooldown(admission.credential, { retryAfterMs, reason })
  await persistProviderConnections().catch((err: unknown) => {
    logger.warn(
      `${logPrefix} failed to persist credential status:`,
      (err as Error).message,
    )
  })
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
