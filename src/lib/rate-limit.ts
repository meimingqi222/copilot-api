import consola from "consola"

import { sleep } from "./utils"

const DEFAULT_INTERVAL_MS = 250
const DEFAULT_BURST = 8
const MAX_BACKOFF_MS = 60_000
const BASE_BACKOFF_MS = 1_000

let limiterLock: Promise<void> = Promise.resolve()
let theoreticalArrivalMs = 0
let cooldownUntilMs = 0
let consecutive429Count = 0

export const adaptiveRateLimitDefaults = {
  intervalMs: DEFAULT_INTERVAL_MS,
  burst: DEFAULT_BURST,
}

export async function checkRateLimit() {
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
  })

  if (waitTimeMs <= 0) return

  const waitTimeSeconds = toWaitSeconds(waitTimeMs)
  consola.warn(
    `Adaptive rate limiter waiting ${waitTimeSeconds} seconds before sending request...`,
  )
  await sleep(waitTimeMs)
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
  theoreticalArrivalMs = 0
  cooldownUntilMs = 0
  consecutive429Count = 0
}

async function withLimiterLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const previousLock = limiterLock
  let releaseLock: (() => void) | undefined
  limiterLock = new Promise<void>((resolve) => {
    releaseLock = resolve
  })

  await previousLock
  try {
    return await fn()
  } finally {
    releaseLock?.()
  }
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
