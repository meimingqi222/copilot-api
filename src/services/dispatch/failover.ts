import type { Context } from "hono"

import type { Account } from "~/lib/accounts"
import type { RouteTarget } from "~/lib/provider-connections"
import type { ClassifiedWsFailure } from "~/services/responses/ws-failure"

import {
  markAccountRateLimited,
  markAccountRateLimitedMs,
  setAccountQuotaState,
  syncLegacyExhaustedState,
} from "~/lib/account-availability"
import { saveAccounts } from "~/lib/account-store"
import { getAccount } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  DEFAULTS,
  classifyUpstreamError,
  getMutableProviderConnection,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  persistProviderConnections,
  syncAccountToConnection,
} from "~/lib/provider-connections"
import {
  switchToNextRouteTarget,
  resolveConnectionFromTarget,
  type RequestAdmission,
} from "~/lib/request-admission"
import { safeOrigin } from "~/lib/request-admission"
import { recordUpstreamAttempt } from "~/lib/request-log"
import { targetKey } from "~/lib/route-target"
import { affinityAuthKey, invalidateSessionAffinityAuth } from "~/lib/routing"
import { isAbortError, shouldFailover } from "~/lib/utils"
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
  } = options
  initializeProtocolAdapters()

  const tried = new Set<string>()
  let current: RequestAdmission = admission

  let attemptIndex = 0
  while (true) {
    const adapter = getProtocolAdapter(current.target.protocol)
    const attemptStart = Date.now()
    try {
      const lease = tryAcquireCredentialLease(current.target)
      if (!lease) {
        throw new CredentialConcurrencyLimitError(
          `credential ${targetKey(current.target)} at in-flight cap`,
        )
      }
      let handedOffToStream = false
      try {
        const result = await execute(adapter, current.target, current)
        recordUpstreamAttempt(
          c,
          {
            ...current.target,
            connectionName: current.connection.name,
            credentialLabel: current.credential.label,
            provider: current.account?.provider ?? current.target.protocol,
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
          provider: current.account?.provider ?? current.target.protocol,
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
      if (!next) throw error

      const resolved = resolveConnectionFromTarget(next)
      if (!resolved) throw error
      current = {
        target: next,
        connection: resolved.connection,
        credential: resolved.credential,
        account: resolved.account,
        initiator: current.initiator,
        // Keep L0 session binding context so subsequent failovers rebind
        // the same conversation to the newly selected credential.
        sessionId: current.sessionId,
        fallbackSessionId: current.fallbackSessionId,
      }
    }
  }
}

/**
 * 批次 3：admission.account 是从 connection 派生的临时对象，
 * 修改它不会写回 state.accounts。通过 id 查找 state.accounts 中的真实 account。
 */
function resolveStateAccount(id: string) {
  return getAccount(id)
}

/**
 * 批次 3：对 state.accounts 中的真实 account 执行冷却/配额/鉴权错误标记。
 * 从 markCooldown 的 account-backed 分支提取，确保修改写回真实对象。
 */
async function markAccountCooldown(
  account: Account,
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
      setAccountQuotaState(account, "exhausted")
      account.cooldownUntil =
        error.retryAfterMs ?
          Date.now() + error.retryAfterMs
        : Date.now() + DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS
      syncLegacyExhaustedState(account)
      const conn = getMutableProviderConnection(account.id)
      if (conn) syncAccountToConnection(conn, account)
      await saveAccounts().catch((err: unknown) => {
        logger.warn(
          `${logPrefix} failed to persist account quota state:`,
          (err as Error).message,
        )
      })
      return
    }
    if (error.kind === "auth_error") {
      invalidateSessionAffinityAuth(authKey)
      account.runtimeState = {
        ...account.runtimeState,
        authStatus: "error",
        lastError: error.message,
      }
      syncLegacyExhaustedState(account)
      const authConn = getMutableProviderConnection(account.id)
      if (authConn) syncAccountToConnection(authConn, account)
      await saveAccounts().catch((err: unknown) => {
        logger.warn(
          `${logPrefix} failed to persist account auth error state:`,
          (err as Error).message,
        )
      })
      return
    }
    // rate_limited / server_error → rate-limit cooldown
    // with the real upstream retryAfterMs (up to 4h for windsurf).
    invalidateSessionAffinityAuth(authKey)
    await markAccountRateLimitedMs(
      account.id,
      error.retryAfterMs,
      `upstream_windsurf_${error.kind}`,
    )
    return
  }

  if (isHttp && error instanceof HTTPError && error.responseBody) {
    const classified = classifyUpstreamError({
      status,
      retryAfterHeader: error.response.headers.get("retry-after"),
      body: error.responseBody,
    })
    if (classified.kind === "quota_exhausted") {
      invalidateSessionAffinityAuth(authKey)
      setAccountQuotaState(account, "exhausted")
      account.cooldownUntil =
        classified.retryAfterMs ?
          Date.now() + classified.retryAfterMs
        : Date.now() + DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS
      syncLegacyExhaustedState(account)
      const quotaConn = getMutableProviderConnection(account.id)
      if (quotaConn) syncAccountToConnection(quotaConn, account)
      await saveAccounts().catch((err: unknown) => {
        logger.warn(
          `${logPrefix} failed to persist account quota state:`,
          (err as Error).message,
        )
      })
      return
    }
  }

  // 429 / 网络错误走 rate-limit 冷却;5xx 不冷却 account、不打散 affinity
  if (status === 429 || !isHttp) {
    invalidateSessionAffinityAuth(authKey)
    await markAccountRateLimited(account.id, new Response(null, { status }))
  }
}

/**
 * Apply account cooldown / quota / auth state from an already-classified WS
 * `response.create` failure (credential scope). Unlike the private markCooldown
 * (which re-derives everything from HTTP heuristics), the scope/kind here is
 * authoritative — quota is quota, 5xx is cooled, 401/403 is auth.
 *
 * Writes back to the ProviderConnection + AccountLegacyMetadata via
 * syncAccountToConnection so the next `listAccounts()` / `isAccountAvailable()`
 * sees the account as unavailable (not just the derived admission.account).
 *
 * WS rotation is account-managed only, so this targets `admission.account`;
 * when absent it falls back to a direct credential cooldown.
 */
export async function recordUpstreamFailure(
  admission: RequestAdmission,
  failure: ClassifiedWsFailure,
  logPrefix = "[ws-failover]",
): Promise<void> {
  const authKey = affinityAuthKey(admission.target)
  invalidateSessionAffinityAuth(authKey)

  const stateAccount =
    admission.account ? resolveStateAccount(admission.account.id) : undefined

  if (stateAccount) {
    switch (failure.kind) {
      case "quota": {
        setAccountQuotaState(stateAccount, "exhausted")
        stateAccount.cooldownUntil =
          failure.retryAfterMs ?
            Date.now() + failure.retryAfterMs
          : Date.now() + DEFAULTS.QUOTA_EXHAUSTED_AUTO_RECOVERY_MS
        syncLegacyExhaustedState(stateAccount)
        const conn = getMutableProviderConnection(stateAccount.id)
        if (conn) syncAccountToConnection(conn, stateAccount)
        await saveAccounts().catch((err: unknown) => {
          logger.warn(
            `${logPrefix} failed to persist account quota state:`,
            (err as Error).message,
          )
        })
        return
      }
      case "auth": {
        stateAccount.runtimeState = {
          ...stateAccount.runtimeState,
          authStatus: "error",
          lastError: `upstream ws auth error${
            failure.status ? ` (HTTP ${failure.status})` : ""
          }`,
        }
        syncLegacyExhaustedState(stateAccount)
        const conn = getMutableProviderConnection(stateAccount.id)
        if (conn) syncAccountToConnection(conn, stateAccount)
        await saveAccounts().catch((err: unknown) => {
          logger.warn(
            `${logPrefix} failed to persist account auth state:`,
            (err as Error).message,
          )
        })
        return
      }
      case "rate":
      case "server": {
        const cooldownMs =
          failure.retryAfterMs
          ?? (failure.kind === "server" ?
            DEFAULTS.COOLDOWN_5XX_MS
          : DEFAULTS.COOLDOWN_429_FALLBACK_MS)
        await markAccountRateLimitedMs(
          stateAccount.id,
          cooldownMs,
          `upstream_ws_${failure.kind}`,
        )
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

  // account-backed 路径:写入 state.accounts + 持久化
  if (admission.account) {
    // 批次 3：admission.account 是派生对象，需要查找 state.accounts 中的真实 account
    const stateAccount = resolveStateAccount(admission.account.id)
    if (stateAccount) {
      await markAccountCooldown(stateAccount, error, {
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
