import type { Context } from "hono"

import type {
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { CredentialLease } from "~/services/dispatch/concurrency"
import type { ClassifiedWsFailure } from "~/services/responses/ws-failure"

import {
  HTTPError,
  LocalConcurrencyLimitError,
  LocalPayloadUnsupportedError,
  LocalUnavailableError,
} from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  addPerformanceTiming,
  markResponseReady,
} from "~/lib/request-performance"
import {
  bindPerformanceStream,
  runWithPerformanceContext,
} from "~/lib/upstream-performance"
import {
  DEFAULTS,
  classifyUpstreamError,
  connectionProvider,
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
  checkRateLimit,
  getRemainingCooldownSeconds,
  RateLimitQueueFullError,
  reportUpstreamRateLimit,
  reportUpstreamRateLimitMs,
  reportUpstreamSuccess,
} from "~/lib/rate-limit"
import {
  retargetGroupDecision,
  type RequestAdmission,
} from "~/lib/request-admission"
import { applyGroupOverrides } from "~/lib/routing-groups/apply"
import {
  getRequestLogContext,
  markAttemptStarting,
  patchRequestLog,
  recordUpstreamAttempt,
} from "~/lib/request-log"
import {
  type RestDecision,
  clearRest,
  recordRest,
  resolveConnectionFromTarget,
  restDecisionFor,
  restDecisionForReason,
  restReasonForErrorKind,
  switchToNextRouteTarget,
  targetKey,
  verifyHeldError,
} from "~/lib/route-target"
import { affinityAuthKey, invalidateSessionAffinityAuth } from "~/lib/routing"
import { isAbortError, safeOrigin, shouldFailover } from "~/lib/utils"
import {
  isCodebuddyModelRateLimit,
  recordCodebuddyModelCooldown,
} from "~/services/codebuddy/model-cooldown"
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
import { WindsurfUpstreamError } from "~/services/windsurf/error-classifier"

interface FailoverOptions<TPayload, TResult> {
  payload: TPayload
  admission: RequestAdmission
  signal?: AbortSignal
  routeKind: "chat" | "messages" | "responses" | "gemini" | "embeddings"
  execute: (
    adapter: ReturnType<typeof getProtocolAdapter>,
    target: RouteTarget,
    current: RequestAdmission,
  ) => Promise<TResult>
  logPrefix?: string
  c?: Context
}

/**
 * Hold `lease` for the lifetime of a streamed result, or report that the
 * result is not a stream so the caller can release immediately.
 *
 * `execute()` does NOT hand back the bare adapter result: `dispatchRequest`
 * wraps it via `decorateResult` into `{ credentialId, response, identity }`.
 * The stream therefore lives on `result.response`, and testing `result` itself
 * was always false — the lease was released before the first chunk, so the
 * per-credential in-flight gate never bounded a single streaming turn.
 *
 * Both shapes are handled: the wrapped shape (what the dispatcher actually
 * returns) and a bare async iterable (so the gate still holds for any
 * `execute()` that returns a stream directly). The wrapper's own shape is
 * preserved — only its `response` is replaced by the lease-holding wrapper —
 * because every caller reads `result.response`.
 */
function holdLeaseForStream<TResult>(
  result: TResult,
  lease: CredentialLease,
  c?: Context,
): { value: TResult; handedOff: boolean } {
  if (isWrappedStream(result)) {
    return {
      value: {
        ...(result as object),
        response: wrapLeaseStream(
          bindPerformanceStream(result.response, c),
          lease,
        ),
      } as TResult,
      handedOff: true,
    }
  }
  if (isAsyncIterable(result)) {
    return {
      value: wrapLeaseStream(
        bindPerformanceStream(result as AsyncIterable<unknown>, c),
        lease,
      ) as TResult,
      handedOff: true,
    }
  }
  return { value: result, handedOff: false }
}

/** True when `value` is a dispatch result whose `response` is a stream. */
function isWrappedStream(
  value: unknown,
): value is { response: AsyncIterable<unknown> } {
  if (!value || typeof value !== "object") return false
  return isAsyncIterable((value as { response?: unknown }).response)
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
        turnKey: current.turnKey,
        affinityMode: current.group?.affinity,
        groupMembers: current.groupMembers,
        groupRouting: current.group?.routing,
        groupId: current.group?.groupId,
        compact: current.compact,
      },
    )
    if (!next) return false
    const resolved = resolveConnectionFromTarget(next)
    if (!resolved) return false
    current = {
      ...current,
      target: next,
      connection: resolved.connection,
      credential: resolved.credential,
    }
    if (current.group) {
      current.group = retargetGroupDecision(current.group, next)
      current.groupOverrides = applyGroupOverrides(payload, current.group, {
        endpoint: routeKind,
        baseline: current.groupOverrideBaseline,
      })
      if (c)
        patchRequestLog(c, {
          routingGroupSelectedMember: current.group.member,
          reasoningEffort: current.groupOverrides.effort,
        })
    }
    return true
  }

  let attemptIndex = 0
  while (true) {
    // A `verify` refusal the vendor gave a moment ago is answered from memory:
    // the account is stopped until someone verifies it, so a fresh upstream
    // call would only collect the same refusal again. Rotate to another
    // candidate; with none left, hand the vendor's own words back.
    const heldVerify = verifyHeldError(
      current.credential.id,
      undefined,
      undefined,
      current.credential.createdAt,
    )
    if (heldVerify !== undefined) {
      tried.add(targetKey(current.target))
      logger.warn(
        `${logPrefix} credential "${current.credential.id}" is verify-held; answering from memory`,
      )
      if (advanceToNextTarget()) continue
      throw new HTTPError(
        heldVerify,
        new Response(heldVerify, { status: 403 }),
        heldVerify,
      )
    }

    const adapter = getProtocolAdapter(current.target.protocol)
    const attemptStart = Date.now()
    const metricAttemptStart = performance.now()
    try {
      // Pacing gate (burst + interval per connection). Runs before lease
      // acquisition so waiting requests don't hold credential leases.
      // Queue-full is local saturation, not an upstream failure — it is
      // handled in the catch block by rotating without any cooldown.
      const rateLimitStarted = performance.now()
      try {
        await checkRateLimit(current.connection.id, signal)
      } finally {
        addPerformanceTiming(
          c,
          "rateLimitWaitMs",
          performance.now() - rateLimitStarted,
        )
      }
      const lease = tryAcquireCredentialLease(current.target)
      if (!lease) {
        throw new CredentialConcurrencyLimitError(targetKey(current.target))
      }
      let handedOffToStream = false
      try {
        // Tell the live trace view which connection/credential is being
        // contacted *before* the upstream call, so an in-flight request is
        // not shown with an empty route for the whole upstream wait.
        markAttemptStarting(c, {
          ...current.target,
          connectionName: current.connection.name,
          credentialLabel: current.credential.label,
          provider: connectionProvider(current.connection),
          upstreamBaseUrl: safeOrigin(current.connection.baseUrl),
        })
        const result = await runWithPerformanceContext(c, () =>
          execute(adapter, current.target, current),
        )
        if (!isWrappedStream(result) && !isAsyncIterable(result))
          markResponseReady(c)
        // Windsurf resolves the real SKU (e.g. glm-5-2-max) from
        // reasoning_effort inside the adapter and patches modelUpstream.
        // recordUpstreamAttempt below would overwrite it with the head
        // default (glm-5-2), so snapshot and restore it.
        const sku = c ? getRequestLogContext(c)?.entry.modelUpstream : undefined
        // Upstream accepted the request: clear any 429 backoff pressure so
        // the next 429 episode starts from the base backoff again, and lift
        // any rest this credential was sitting out.
        await reportUpstreamSuccess(current.connection.id)
        clearRest(current.credential.id)
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
        if (c && sku && sku !== current.target.upstreamModelId) {
          patchRequestLog(c, { modelUpstream: sku })
        }
        // Hold the lease for the full stream lifetime, not until the iterable
        // is returned. See `holdLeaseForStream` for why the stream is not on
        // `result` itself.
        const leased = holdLeaseForStream(result, lease, c)
        handedOffToStream = leased.handedOff
        return leased.value
      } finally {
        if (!handedOffToStream) lease.release()
      }
    } catch (error) {
      addPerformanceTiming(
        c,
        "failedAttemptMs",
        performance.now() - metricAttemptStart,
      )
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
      let rest: RestDecision | undefined
      if (error instanceof HTTPError) {
        // A local concurrency rejection is not an upstream failure: label it as
        // such in the attempts log instead of letting status 429 classify as
        // `rate_limited` (which reads as an upstream rate limit).
        if (error instanceof LocalConcurrencyLimitError) {
          errorCode = "concurrency_limit"
          errorSnippet = error.message
        } else if (error instanceof LocalPayloadUnsupportedError) {
          errorCode = "semantic_unsupported"
          errorSnippet = error.message
        } else if (error instanceof LocalUnavailableError) {
          errorCode = "local_unavailable"
          errorSnippet = error.message
        } else {
          const classified = classifyUpstreamError({
            status: error.response.status,
            headers: error.response.headers,
            body: error.responseBody,
          })
          errorCode = classified.kind
          retryAfterMs = classified.retryAfterMs
          errorSnippet = error.responseBody
          // Semantic rest reason + duration (Phase 3): reads the vendor's
          // words so quota rests its real window and credit its own band,
          // instead of one flat backoff.
          rest = restDecisionFor({
            status: error.response.status,
            headers: error.response.headers,
            body: error.responseBody,
            fallbackMs:
              classified.retryAfterMs ?? DEFAULTS.COOLDOWN_429_FALLBACK_MS,
          })
        }
      } else if (error instanceof WindsurfUpstreamError) {
        errorCode = error.kind
        retryAfterMs = error.retryAfterMs
        errorSnippet = error.message
        rest = restDecisionForReason({
          reason: restReasonForErrorKind(error.kind),
          retryAfterMs: error.retryAfterMs,
          fallbackMs: DEFAULTS.COOLDOWN_429_FALLBACK_MS,
        })
      } else if (error instanceof Error) {
        errorCode = error.name
        rest = restDecisionForReason({
          reason: "network",
          fallbackMs: DEFAULTS.COOLDOWN_NETWORK_MS,
        })
      }
      const failedSku =
        c ? getRequestLogContext(c)?.entry.modelUpstream : undefined
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
          restReason: rest?.reason,
          restUntilMs: rest?.untilMs,
        },
        idx,
      )
      if (c && failedSku && failedSku !== current.target.upstreamModelId) {
        patchRequestLog(c, { modelUpstream: failedSku })
      }
      tried.add(targetKey(current.target))

      // A local unavailability (e.g. the Claude Code binary is missing) is a
      // machine-level condition: every account would fail identically. Do not
      // cool the credential, do not advance to the next target — rethrow as-is.
      if (error instanceof LocalUnavailableError) {
        throw error
      }

      if (error instanceof LocalPayloadUnsupportedError) {
        if (advanceToNextTarget()) continue
        throw error
      }

      if (
        error instanceof HTTPError
        && !(error instanceof LocalConcurrencyLimitError)
        && !shouldFailover(error)
      ) {
        await markCooldown(current, error, logPrefix, rest)
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

      // 内容策略拦截是请求内容问题，不是账号或线路故障：不冷却账号（否则该
      // 账号上其他客户端的请求会跟着吃 429），也不换 target 重试（同一份
      // prompt 在任何凭证上都会被同样拒绝）。直接以 400 抛出，让客户端拿到
      // 可读、不可重试的错误，而不是笼统的 500。
      if (
        error instanceof WindsurfUpstreamError
        && error.kind === "content_policy"
      ) {
        throw new HTTPError(
          error.message,
          new Response(null, { status: 400 }),
          error.message,
        )
      }

      // A local per-account / per-credential concurrency rejection is not an
      // upstream failure: do not cool down or mark the account. It is safe to
      // try another route target, while preserving the 429 if no target is
      // available.
      if (!(error instanceof LocalConcurrencyLimitError)) {
        await markCooldown(current, error, logPrefix, rest)
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
    rest?: RestDecision
  },
): Promise<void> {
  const { status, isHttp, authKey, logPrefix, rest } = ctx
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
    // Phase 3: credit (out of balance) and verify (vendor wants the account
    // verified) rest their own bands; a true quota reads the real window from
    // the vendor's words (rest.restMs), capped at 8d.
    if (rest?.reason === "credit") {
      invalidateSessionAffinityAuth(authKey)
      setConnectionQuotaState(conn, "exhausted")
      setConnectionCooldownUntil(conn, Date.now() + rest.restMs)
      syncConnectionExhaustedState(conn)
      await persistConnectionState(logPrefix, "connection credit state")
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
      setConnectionQuotaState(conn, "exhausted")
      setConnectionCooldownUntil(
        conn,
        rest?.reason === "quota" ? Date.now() + rest.restMs
        : classified.retryAfterMs ? Date.now() + classified.retryAfterMs
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
        rest?.reason === "rate" ? rest.restMs : classified.retryAfterMs,
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
 * ConnectionMetadata 上,使下一次 availability 检查
 * (isConnectionAvailable / getConnectionRoutability)看到不可用状态。
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
  rest?: RestDecision,
): Promise<void> {
  // CodeBuddy 6004 模型级限流：只冷却 (credential, model)，跳过账号级标记。
  // HTTP 错误路径 adapter 已落库（幂等复写）；流错误路径（safeSseStream
  // 直抛 HTTPError）在补录。其它 provider 不走此分支，行为不变。
  if (
    error instanceof HTTPError
    && admission.connection.protocol === "codebuddy-native"
    && isCodebuddyModelRateLimit(error.response.status, error.responseBody)
  ) {
    recordCodebuddyModelCooldown({
      connectionId: admission.connection.id,
      credentialId: admission.credential.id,
      model: admission.target.upstreamModelId,
      body: error.responseBody ?? "",
    })
    return
  }

  const isHttp = error instanceof HTTPError
  const status = isHttp ? error.response.status : 503
  const authKey = affinityAuthKey(admission.target)

  // Record the richer rest (by / failures / link) so the trace can say why
  // the candidate sits out and for how long, and so a verify refusal can be
  // held for a short while. A zero duration still bumps the failure streak.
  //
  // A plain 4xx is the request's fault, not the account's — the branches below
  // rotate it without cooling the credential — so it must not leave a rest
  // behind either. `unknown` is the classifier's word for exactly that case
  // (a semantic reason such as credit or verify outranks it).
  const requestFault = isHttp && rest?.reason === "unknown"
  if (rest && !requestFault) {
    recordRest({
      credentialId: admission.credential.id,
      // Bind the rest to this credential instance, so deleting and re-adding
      // the same key doesn't inherit a rest taken by the one before it.
      credentialCreatedAt: admission.credential.createdAt,
      reason: rest.reason,
      by: rest.by,
      untilMs: rest.restMs > 0 ? rest.untilMs : 0,
      said: isHttp ? (error.responseBody ?? undefined) : undefined,
    })
  }

  // Phase 3: a semantic refusal (the vendor's safety filter, an unapproved
  // channel) rests nothing — same prompt fails everywhere — so leave the
  // credential ready and let the caller rotate / surface it.
  if (rest?.reason === "refused") {
    admission.credential.lastError = "upstream refused"
    admission.credential.lastErrorAt = Date.now()
    await persistCredentialState(logPrefix)
    return
  }

  // account-managed 路径:直接写回 ProviderConnection + 持久化
  if (isAccountManagedConnection(admission.connection)) {
    const conn = resolveStateConnection(admission.connection.id)
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

  // 纯 provider 路径:标记 credential cooldown / quota_exhausted
  invalidateSessionAffinityAuth(authKey)
  let classified: ReturnType<typeof classifyUpstreamError> | undefined
  // isHttp 为真时 error 必为 HTTPError,别名收窄后直接取用,不再重复断言。
  const errorBody = isHttp ? error.responseBody : undefined
  const shortReason =
    isHttp ?
      `upstream ${status}: ${(errorBody ?? "").slice(0, 200)}`
    : `upstream ${status}`
  if (isHttp) {
    // Use classifyUpstreamError for accurate categorization, especially
    // for Codex usage_limit_reached which needs quota_exhausted treatment.
    classified = classifyUpstreamError({
      status,
      headers: error.response.headers,
      body: errorBody,
    })
    // Phase 3: credit and verify are their own rest bands, told apart from a
    // true quota by the vendor's words.
    if (rest?.reason === "credit") {
      markCredentialQuotaExhausted(
        admission.credential,
        shortReason,
        rest.restMs,
      )
      await persistCredentialState(logPrefix)
      return
    }
    if (rest?.reason === "verify") {
      markCredentialCooldown(admission.credential, {
        retryAfterMs: rest.restMs,
        reason: `upstream verify: ${shortReason}`,
      })
      await persistCredentialState(logPrefix)
      return
    }
    if (classified.kind === "quota_exhausted") {
      markCredentialQuotaExhausted(
        admission.credential,
        shortReason,
        rest?.reason === "quota" ? rest.restMs : classified.retryAfterMs,
      )
      await persistCredentialState(logPrefix)
      return
    }
    if (classified.kind === "auth_error") {
      markCredentialAuthError(admission.credential, shortReason)
      await persistCredentialState(logPrefix)
      return
    }
    if (classified.kind === "client_error" || classified.kind === "unknown") {
      // 400 等请求问题是 payload 导致的,不是上游限流/故障:只记录错误,
      // 不进 cooldown,否则下一轮会误报 429
      // (如 atria 不支持 previous_response_id 的 400 upstream_error)。
      // 与 shared.handleUpstreamFailure / account-managed 路径保持一致。
      admission.credential.lastError = shortReason
      admission.credential.lastErrorAt = Date.now()
      await persistCredentialState(logPrefix)
      return
    }
  }
  const retryAfterMs =
    rest?.reason === "rate" ?
      rest.restMs
    : (classified?.retryAfterMs ?? resolveRetryAfterMs(isHttp, status))
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
  await persistCredentialState(logPrefix)
}

/** 凭据状态写回落盘,失败只告警,不影响本次标记结果。 */
async function persistCredentialState(logPrefix: string): Promise<void> {
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
