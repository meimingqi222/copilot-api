import consola from "consola"

import { sleep } from "./utils"

const DEFAULT_INTERVAL_MS = 250
const DEFAULT_BURST = 8
const MAX_BACKOFF_MS = 60_000
const BASE_BACKOFF_MS = 1_000
const MAX_QUEUE_SIZE = 100

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

export async function checkRateLimit(accountId: string, signal?: AbortSignal) {
  const state = getAccountState(accountId)
  const waitTimeMs = await withLimiterLock(
    state,
    () => {
      const now = Date.now()
      const allowedAt = Math.max(
        state.cooldownUntilMs,
        state.theoreticalArrivalMs - (DEFAULT_BURST - 1) * DEFAULT_INTERVAL_MS,
      )

      if (now < allowedAt) {
        const waitMs = Math.ceil(allowedAt - now)
        state.theoreticalArrivalMs =
          Math.max(state.theoreticalArrivalMs, allowedAt) + DEFAULT_INTERVAL_MS
        return waitMs
      }

      state.theoreticalArrivalMs =
        Math.max(now, state.theoreticalArrivalMs) + DEFAULT_INTERVAL_MS
      return 0
    },
    signal,
  )

  if (waitTimeMs <= 0) return

  consola.warn(
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

  consola.warn(
    `Upstream returned 429 for account "${accountId}": ${JSON.stringify({
      retryAfterHeader: response.headers.get("retry-after"),
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
    consola.info(
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
 */
export function getRemainingCooldownSeconds(accountId: string): number {
  const state = accountLimiters.get(accountId)
  if (!state) return 0

  const remaining = state.cooldownUntilMs - Date.now()
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

export function getAccountRateLimitSnapshot(
  accountId: string,
): Record<string, number | boolean> {
  const state = accountLimiters.get(accountId)
  if (!state) {
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
    limiterQueueSize: state.limiterQueueSize,
    cooldownRemainingSeconds: Math.max(
      0,
      Math.ceil((state.cooldownUntilMs - now) / 1000),
    ),
    consecutive429Count: state.consecutive429Count,
    theoreticalArrivalDelayMs: Math.max(
      0,
      Math.ceil(state.theoreticalArrivalMs - now),
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

function parseRetryAfterMs(retryAfterValue: string | null): number | undefined {
  if (!retryAfterValue) return undefined

  const retryAfterSeconds = Number.parseFloat(retryAfterValue)
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.round(retryAfterSeconds * 1000)
  }

  const retryAfterDateMs = Date.parse(retryAfterValue)
  if (Number.isNaN(retryAfterDateMs)) return undefined

  return Math.max(0, retryAfterDateMs - Date.now())
}

function computeBackoffMs(consecutive429: number): number {
  const exponent = Math.max(0, Math.min(consecutive429 - 1, 6))
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent)
}

function toWaitSeconds(waitTimeMs: number): number {
  return Math.max(1, Math.ceil(waitTimeMs / 1000))
}
