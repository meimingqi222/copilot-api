import consola from "consola"

import { sleep } from "./utils"

const DEFAULT_INTERVAL_MS = 250
const DEFAULT_BURST = 8
const MAX_BACKOFF_MS = 60_000
const BASE_BACKOFF_MS = 1_000
const MAX_QUEUE_SIZE = 100

let limiterLock: Promise<void> = Promise.resolve()
let limiterQueueSize = 0
let theoreticalArrivalMs = 0
let cooldownUntilMs = 0
let consecutive429Count = 0

export const adaptiveRateLimitDefaults = {
  intervalMs: DEFAULT_INTERVAL_MS,
  burst: DEFAULT_BURST,
}

export class RateLimitQueueFullError extends Error {
  constructor() {
    super("Rate limiter queue is full")
    this.name = "RateLimitQueueFullError"
  }
}

export async function checkRateLimit(signal?: AbortSignal) {
  const waitTimeMs = await withLimiterLock(() => {
    const now = Date.now()
    const allowedAt = Math.max(
      cooldownUntilMs,
      theoreticalArrivalMs - (DEFAULT_BURST - 1) * DEFAULT_INTERVAL_MS,
    )

    if (now < allowedAt) {
      const waitMs = Math.ceil(allowedAt - now)
      theoreticalArrivalMs =
        Math.max(theoreticalArrivalMs, allowedAt) + DEFAULT_INTERVAL_MS
      return waitMs
    }

    theoreticalArrivalMs =
      Math.max(now, theoreticalArrivalMs) + DEFAULT_INTERVAL_MS
    return 0
  }, signal)

  if (waitTimeMs <= 0) return

  consola.warn(
    `Adaptive rate limiter waiting ${toWaitSeconds(waitTimeMs)} seconds before sending request...`,
  )
  await sleep(waitTimeMs, signal)
}

export async function reportUpstreamRateLimit(response: Response) {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"))

  await withLimiterLock(() => {
    consecutive429Count += 1

    const adaptivePenaltyMs =
      retryAfterMs ?? computeBackoffMs(consecutive429Count)
    const cooldownMs = Math.max(1, adaptivePenaltyMs)
    const cooldownUntil = Date.now() + cooldownMs

    cooldownUntilMs = Math.max(cooldownUntilMs, cooldownUntil)
    theoreticalArrivalMs = Math.max(theoreticalArrivalMs, cooldownUntilMs)

    consola.warn(
      `Upstream returned 429. Applying adaptive cooldown for ${toWaitSeconds(cooldownMs)} seconds.`,
    )
  })
}

export async function reportUpstreamSuccess() {
  await withLimiterLock(() => {
    consecutive429Count = 0

    if (Date.now() >= cooldownUntilMs) {
      cooldownUntilMs = 0
    }
  })
}

export function resetAdaptiveRateLimiterForTest() {
  limiterLock = Promise.resolve()
  limiterQueueSize = 0
  theoreticalArrivalMs = 0
  cooldownUntilMs = 0
  consecutive429Count = 0
}

export async function holdLimiterLockForTest(ms: number): Promise<void> {
  await withLimiterLock(() => sleep(ms))
}

async function withLimiterLock<T>(
  fn: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal)

  if (limiterQueueSize >= MAX_QUEUE_SIZE) {
    throw new RateLimitQueueFullError()
  }

  limiterQueueSize += 1

  const previousLock = limiterLock
  let releaseLock!: () => void
  limiterLock = new Promise<void>((resolve) => {
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
    limiterQueueSize -= 1
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
