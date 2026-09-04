import { logger } from "~/lib/logger"
import { getProviderConnection } from "~/lib/provider-connections"
import { parseRetryAfterMs } from "~/lib/retry-after"

import { sleep } from "./utils"

const DEFAULT_INTERVAL_MS = 250
const DEFAULT_BURST = 8
const MAX_BACKOFF_MS = 60_000
const BASE_BACKOFF_MS = 1_000
const MAX_QUEUE_SIZE = 100

/**
 * Windsurf per-model message-rate quotas reset in multi-hour windows
 * (e.g. "Resets in: 3h0m0s"). The default MAX_BACKOFF_MS (60s) is far too
 * short and causes immediate retry → re-trigger. This ceiling applies only
 * to the windsurf-aware `reportUpstreamRateLimitMs` path.
 */
const MAX_WINDSURF_COOLDOWN_MS = 4 * 60 * 60 * 1_000

interface AccountRateLimitState {
  limiterLock: Promise<void>
  limiterQueueSize: number
  theoreticalArrivalMs: number
  cooldownUntilMs: number
  consecutive429Count: number
}

const accountLimiters = new Map<string, AccountRateLimitState>()

function getAccountState(accountId: string): AccountRateLimitState {
  let state = accountLimiters.get(accountId)
  if (!state) {
    state = {
      limiterLock: Promise.resolve(),
      limiterQueueSize: 0,
      theoreticalArrivalMs: 0,
      cooldownUntilMs: 0,
      consecutive429Count: 0,
    }
    accountLimiters.set(accountId, state)
  }
  return state
}

export const adaptiveRateLimitDefaults = {
  intervalMs: DEFAULT_INTERVAL_MS,
  burst: DEFAULT_BURST,
}

/**
 * Clear rate limit state for a specific account.
 * Should be called when an account is deleted.
 */
export function clearAccountRateLimitState(accountId: string): void {
  accountLimiters.delete(accountId)
}

export class RateLimitQueueFullError extends Error {
  constructor() {
    super("Rate limiter queue is full")
    this.name = "RateLimitQueueFullError"
  }
}

/**
 * Check rate limit for an account.
 *
 * @param accountId Account ID to gate.
 * @param signal Optional abort signal.
 * @param opts Optional override for interval/burst. Used by providers that
 *   need stricter pacing (e.g. Windsurf's per-model message-rate quota is
 *   far more sensitive than GitHub Copilot's per-minute 429). When omitted,
 *   uses the global defaults (250ms / 8 burst).
 */
export async function checkRateLimit(
  accountId: string,
  signal?: AbortSignal,
  opts?: { intervalMs?: number; burst?: number },
) {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS
  const burst = opts?.burst ?? DEFAULT_BURST
  const state = getAccountState(accountId)
  const waitTimeMs = await withLimiterLock(
    state,
    () => {
      const now = Date.now()
      const allowedAt = Math.max(
        state.cooldownUntilMs,
        state.theoreticalArrivalMs - (burst - 1) * intervalMs,
      )

      if (now < allowedAt) {
        const waitMs = Math.ceil(allowedAt - now)
        state.theoreticalArrivalMs =
          Math.max(state.theoreticalArrivalMs, allowedAt) + intervalMs
        return waitMs
      }

      state.theoreticalArrivalMs =
        Math.max(now, state.theoreticalArrivalMs) + intervalMs
      return 0
    },
    signal,
  )

  if (waitTimeMs <= 0) return

  logger.warn(
    `Adaptive rate limiter waiting ${toWaitSeconds(waitTimeMs)} seconds before sending request: ${JSON.stringify(
      {
        accountId,
        waitTimeMs,
        state: getAccountRateLimitSnapshot(accountId),
      },
    )}`,
  )
  await sleep(waitTimeMs, signal)
}

export async function reportUpstreamRateLimit(
  accountId: string,
  response: Response,
) {
  const state = getAccountState(accountId)
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"))
  let appliedCooldownMs = 0

  await withLimiterLock(state, () => {
    state.consecutive429Count += 1

    const adaptivePenaltyMs =
      retryAfterMs ?? computeBackoffMs(state.consecutive429Count)
    appliedCooldownMs = Math.min(MAX_BACKOFF_MS, Math.max(1, adaptivePenaltyMs))
    const cooldownUntil = Date.now() + appliedCooldownMs

    state.cooldownUntilMs = Math.max(state.cooldownUntilMs, cooldownUntil)
    state.theoreticalArrivalMs = Math.max(
      state.theoreticalArrivalMs,
      state.cooldownUntilMs,
    )
  })

  logger.warn(
    `Upstream returned 429 for account "${accountId}": ${JSON.stringify({
      retryAfterHeader: response.headers.get("retry-after"),
      retryAfterMs,
      appliedCooldownMs,
      state: getAccountRateLimitSnapshot(accountId),
    })}`,
  )
}

/**
 * Like `reportUpstreamRateLimit` but accepts an explicit `retryAfterMs`
 * (parsed from a response body rather than a Retry-After header).
 *
 * Used by the Windsurf path: Windsurf returns in-stream JSON error frames
 * such as {"error":{"code":"Permission denied","message":"...Resets in:
 * 3h0m0s..."}} after a 200 OK — no Retry-After header, the duration is
 * embedded in the natural-language message. This applies the real upstream
 * cooldown window (up to MAX_WINDSURF_COOLDOWN_MS) instead of the default
 * 60s exponential backoff.
 */
export async function reportUpstreamRateLimitMs(
  accountId: string,
  retryAfterMs?: number,
): Promise<void> {
  const state = getAccountState(accountId)
  let appliedCooldownMs = 0

  await withLimiterLock(state, () => {
    state.consecutive429Count += 1

    const adaptivePenaltyMs =
      retryAfterMs ?? computeBackoffMs(state.consecutive429Count)
    appliedCooldownMs = Math.min(
      MAX_WINDSURF_COOLDOWN_MS,
      Math.max(1, adaptivePenaltyMs),
    )
    const cooldownUntil = Date.now() + appliedCooldownMs

    state.cooldownUntilMs = Math.max(state.cooldownUntilMs, cooldownUntil)
    state.theoreticalArrivalMs = Math.max(
      state.theoreticalArrivalMs,
      state.cooldownUntilMs,
    )
  })

  logger.warn(
    `Windsurf upstream rate-limited account "${accountId}": ${JSON.stringify({
      retryAfterMs,
      appliedCooldownMs,
      state: getAccountRateLimitSnapshot(accountId),
    })}`,
  )
}

export async function reportUpstreamSuccess(accountId: string) {
  const state = getAccountState(accountId)
  let hadRateLimitPressure: boolean | undefined
  await withLimiterLock(state, () => {
    hadRateLimitPressure =
      state.consecutive429Count > 0 || Date.now() < state.cooldownUntilMs
    state.consecutive429Count = 0

    if (Date.now() >= state.cooldownUntilMs) {
      state.cooldownUntilMs = 0
    }
  })

  if (hadRateLimitPressure === true) {
    logger.info(
      `Adaptive rate limiter recovered for account "${accountId}": ${JSON.stringify(
        {
          accountId,
          state: getAccountRateLimitSnapshot(accountId),
        },
      )}`,
    )
  }
}

export function resetAdaptiveRateLimiterForTest() {
  accountLimiters.clear()
}

/**
 * Get the remaining cooldown time for an account in seconds.
 * Returns 0 if the account is not in cooldown.
 *
 * NOTE (Side Effect): If the memory limiter state does not have an active cooldown
 * but the account object has a valid persisted `cooldownUntil` timestamp, this function
 * will automatically sync the account's cooldown state into the memory limiter. This is
 * necessary to restore the cooldown states correctly across application restarts.
 */
export function getRemainingCooldownSeconds(accountId: string): number {
  const limiterState = getAccountState(accountId)

  if (limiterState.cooldownUntilMs <= Date.now()) {
    // Sync persisted cooldown from connection's credential to in-memory rate
    // limiter state. Phase 3: cooldownUntil 现存储在 credential.cooldownUntil
    // (由 setConnectionCooldownUntil 同步写入 metadata + credential)。
    const connection = getProviderConnection(accountId)
    const cooldownUntil = connection?.credentials[0]?.cooldownUntil
    if (
      cooldownUntil
      && typeof cooldownUntil === "number"
      && cooldownUntil > Date.now()
    ) {
      limiterState.cooldownUntilMs = cooldownUntil
    }
  }

  const remaining = limiterState.cooldownUntilMs - Date.now()
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

export function getAccountRateLimitSnapshot(
  accountId: string,
): Record<string, number | boolean> {
  const limiterState = accountLimiters.get(accountId)
  if (!limiterState) {
    return {
      hasState: false,
      limiterQueueSize: 0,
      cooldownRemainingSeconds: 0,
      consecutive429Count: 0,
      theoreticalArrivalDelayMs: 0,
    }
  }

  const now = Date.now()
  return {
    hasState: true,
    limiterQueueSize: limiterState.limiterQueueSize,
    cooldownRemainingSeconds: Math.max(
      0,
      Math.ceil((limiterState.cooldownUntilMs - now) / 1000),
    ),
    consecutive429Count: limiterState.consecutive429Count,
    theoreticalArrivalDelayMs: Math.max(
      0,
      Math.ceil(limiterState.theoreticalArrivalMs - now),
    ),
  }
}

export async function holdLimiterLockForTest(
  accountId: string,
  ms: number,
): Promise<void> {
  const state = getAccountState(accountId)
  await withLimiterLock(state, () => sleep(ms))
}

async function withLimiterLock<T>(
  state: AccountRateLimitState,
  fn: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal)

  if (state.limiterQueueSize >= MAX_QUEUE_SIZE) {
    throw new RateLimitQueueFullError()
  }

  state.limiterQueueSize += 1

  const previousLock = state.limiterLock
  let releaseLock!: () => void
  state.limiterLock = new Promise<void>((resolve) => {
    releaseLock = resolve
  })

  let acquired = false
  try {
    await (signal ?
      Promise.race([previousLock, onceAbort(signal)])
    : previousLock)
    acquired = true

    throwIfAborted(signal)
    return await fn()
  } catch (e) {
    if (!acquired) {
      void previousLock.finally(() => releaseLock())
    }
    throw e
  } finally {
    if (acquired) releaseLock()
    state.limiterQueueSize -= 1
  }
}

function makeAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw makeAbortError(signal)
  }
}

function onceAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(makeAbortError(signal)), {
      once: true,
    })
  })
}

function computeBackoffMs(consecutive429: number): number {
  const exponent = Math.max(0, Math.min(consecutive429 - 1, 6))
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent)
}

function toWaitSeconds(waitTimeMs: number): number {
  return Math.max(1, Math.ceil(waitTimeMs / 1000))
}
