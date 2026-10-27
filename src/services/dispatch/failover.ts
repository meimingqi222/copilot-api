import type { Context } from "hono"

import type { RestDecision } from "~/lib/route-target"
import type { RouteTarget } from "~/lib/provider-connections"
import type { CredentialLease } from "~/services/dispatch/concurrency"

import {
  HTTPError,
  LocalConcurrencyLimitError,
  LocalPayloadUnsupportedError,
  LocalUnavailableError,
  localRateLimitError,
} from "~/lib/error"
import { createLogger } from "~/lib/logger"
import { identityFromAdmission, recordAccountUsage } from "~/lib/usage"
import {
  takeUsagePricingRounds,
  toPricingRound,
} from "~/lib/usage-pricing-rounds"
import {
  addPerformanceTiming,
  markResponseReady,
} from "~/lib/request-performance"
import {
  bindPerformanceStream,
  runWithPerformanceContext,
} from "~/lib/upstream-performance"
import { connectionProvider } from "~/lib/provider-connections"
import {
  checkRateLimit,
  getRemainingCooldownSeconds,
  RateLimitQueueFullError,
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
  clearRest,
  resolveConnectionFromTarget,
  switchToNextRouteTarget,
  targetKey,
  verifyHeldError,
} from "~/lib/route-target"
import { isAbortError, safeOrigin, shouldFailover } from "~/lib/utils"
import {
  isAsyncIterable,
  tryAcquireCredentialLease,
  wrapLeaseStream,
  waitForAdmissionLease,
} from "~/services/dispatch/concurrency"
import {
  classifyAttemptFailure,
  logAttemptFailure,
  markCooldown,
  toNonRetryableContentPolicyError,
} from "~/services/dispatch/cooldown"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

const logger = createLogger("dispatch")

export { recordUpstreamFailure } from "~/services/dispatch/cooldown"

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

function applyCurrentGroupOverrides(
  payload: { model: string },
  current: RequestAdmission,
  endpoint: FailoverOptions<unknown, unknown>["routeKind"],
  c?: Context,
): void {
  if (!current.group) return
  current.groupOverrides = applyGroupOverrides(payload, current.group, {
    endpoint,
    baseline: current.groupOverrideBaseline,
  })
  if (c)
    patchRequestLog(c, {
      routingGroupSelectedMember: current.group.member,
      reasoningEffort: current.groupOverrides.effort,
    })
}

function recordFailedAttemptUsage(
  current: RequestAdmission,
  c: Context | undefined,
  error: unknown,
): void {
  const rounds =
    c ? (takeUsagePricingRounds(c, current.connection.id) ?? []) : []
  if (error instanceof HTTPError && error.reportedUsage) {
    rounds.push(toPricingRound(error.reportedUsage))
  }
  recordAccountUsage({
    identity: identityFromAdmission(current),
    model: current.target.publicModelId,
    rounds,
    serviceTier: error instanceof HTTPError ? error.serviceTier : undefined,
  })
}

function attemptTargetMetadata(current: RequestAdmission) {
  return {
    ...current.target,
    connectionName: current.connection.name,
    credentialLabel: current.credential.label,
    provider: connectionProvider(current.connection),
    upstreamBaseUrl: safeOrigin(current.connection.baseUrl),
  }
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
      applyCurrentGroupOverrides(payload, current, routeKind, c)
    }
    return true
  }

  const saturated = new Map<string, RequestAdmission>()
  let attemptIndex = 0
  while (true) {
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

    const attemptStart = Date.now()
    const metricAttemptStart = performance.now()
    try {
      signal?.throwIfAborted()
      let lease = tryAcquireCredentialLease(current.target)
      if (!lease) {
        saturated.set(targetKey(current.target), current)
        tried.add(targetKey(current.target))
        if (advanceToNextTarget()) continue
        const granted = await waitForAdmissionLease(
          [...saturated.values()],
          signal,
        )
        lease = granted.lease
        current = granted.admission
      }
      for (const key of saturated.keys()) tried.delete(key)
      saturated.clear()
      let handedOffToStream = false
      try {
        const adapter = getProtocolAdapter(current.target.protocol)
        applyCurrentGroupOverrides(payload, current, routeKind, c)
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
        markAttemptStarting(c, attemptTargetMetadata(current))
        const result = await runWithPerformanceContext(c, () =>
          execute(adapter, current.target, current),
        )
        if (!isWrappedStream(result) && !isAsyncIterable(result))
          markResponseReady(c)
        const sku = c ? getRequestLogContext(c)?.entry.modelUpstream : undefined
        await reportUpstreamSuccess(current.connection.id)
        clearRest(current.credential.id)
        recordUpstreamAttempt(
          c,
          attemptTargetMetadata(current),
          { status: 200, latencyMs: Date.now() - attemptStart },
          ++attemptIndex,
        )
        if (c && sku && sku !== current.target.upstreamModelId) {
          patchRequestLog(c, { modelUpstream: sku })
        }
        const leased = holdLeaseForStream(result, lease, c)
        handedOffToStream = leased.handedOff
        return leased.value
      } finally {
        if (!handedOffToStream) lease.release()
      }
    } catch (error) {
      recordFailedAttemptUsage(current, c, error)
      addPerformanceTiming(
        c,
        "failedAttemptMs",
        performance.now() - metricAttemptStart,
      )
      if (error instanceof RateLimitQueueFullError) {
        tried.add(targetKey(current.target))
        logger.warn(
          `${logPrefix} pacing queue full for connection "${current.connection.name}", rotating to next target`,
        )
        if (advanceToNextTarget()) continue
        throw localRateLimitError("Rate limiter queue is full")
      }
      if (signal?.aborted || isAbortError(error)) throw error

      const latencyMs = Date.now() - attemptStart
      const idx = ++attemptIndex
      const { status, errorCode, retryAfterMs, errorSnippet, rest } =
        classifyAttemptFailure(error)
      const failedSku =
        c ? getRequestLogContext(c)?.entry.modelUpstream : undefined
      recordUpstreamAttempt(
        c,
        attemptTargetMetadata(current),
        {
          status,
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
        throw withRetryAdvice(error, current, rest)
      }

      logAttemptFailure(logPrefix, current, error)

      const contentPolicyError = toNonRetryableContentPolicyError(error)
      if (contentPolicyError) {
        throw contentPolicyError
      }

      if (!(error instanceof LocalConcurrencyLimitError)) {
        await markCooldown(current, error, logPrefix, rest)
      }

      if (!advanceToNextTarget()) throw withRetryAdvice(error, current, rest)
    }
  }
}

/**
 * A 429 without retry advice is terminal for clients that wait on `Retry-After`
 * (Codex ends the turn on one — "exceeded retry limit, last status: 429").
 * The rest this failure just took is exactly how long routing refuses the
 * target, so that is what the client is told when the upstream said nothing.
 */
function withRetryAdvice(
  error: unknown,
  admission: RequestAdmission,
  rest?: RestDecision,
): unknown {
  if (!(error instanceof HTTPError) || error.response.status !== 429) {
    return error
  }
  if (error.response.headers.has("Retry-After")) return error
  const restMs =
    rest?.untilMs && rest.untilMs > Date.now() ? rest.untilMs - Date.now() : 0
  const gateMs = getRemainingCooldownSeconds(admission.connection.id) * 1000
  const waitMs = Math.max(restMs, gateMs)
  if (!(waitMs > 0)) return error
  const seconds = Math.max(1, Math.ceil(waitMs / 1000))
  error.response.headers.set("Retry-After", String(seconds))
  error.response.headers.set("retry-after-ms", String(seconds * 1000))
  error.response.headers.set("x-ratelimit-reset", String(seconds))
  return error
}
