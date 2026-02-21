import { afterEach, describe, expect, test } from "bun:test"

import {
  adaptiveRateLimitDefaults,
  checkRateLimit,
  holdLimiterLockForTest,
  RateLimitQueueFullError,
  reportUpstreamRateLimit,
  resetAdaptiveRateLimiterForTest,
} from "~/lib/rate-limit"
import { sleep } from "~/lib/utils"

afterEach(() => {
  resetAdaptiveRateLimiterForTest()
})

describe("adaptive rate limiter", () => {
  test("allows a burst of parallel requests", async () => {
    const start = Date.now()
    await Promise.all(
      Array.from({ length: adaptiveRateLimitDefaults.burst }, () =>
        checkRateLimit(),
      ),
    )
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(adaptiveRateLimitDefaults.intervalMs)
  })

  test("queues requests after burst capacity", async () => {
    await Promise.all(
      Array.from({ length: adaptiveRateLimitDefaults.burst }, () =>
        checkRateLimit(),
      ),
    )

    const start = Date.now()
    await checkRateLimit()
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(
      adaptiveRateLimitDefaults.intervalMs - 25,
    )
  })

  test("adapts cooldown from upstream retry-after", async () => {
    const response = new Response(null, {
      status: 429,
      headers: { "retry-after": "0.05" },
    })
    await reportUpstreamRateLimit(response)

    const start = Date.now()
    await checkRateLimit()
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(40)
  })
})

describe("sleep with AbortSignal", () => {
  test("resolves normally when not aborted", async () => {
    const start = Date.now()
    await sleep(50)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })

  test("rejects immediately when signal already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const err = await sleep(1000, ac.signal).catch((e: unknown) => e)
    expect((err as Error).name).toBe("AbortError")
  })

  test("rejects early when aborted during sleep", async () => {
    const ac = new AbortController()
    const start = Date.now()
    setTimeout(() => ac.abort(), 30)
    const err = await sleep(1000, ac.signal).catch((e: unknown) => e)
    expect((err as Error).name).toBe("AbortError")
    expect(Date.now() - start).toBeLessThan(200)
  })
})

describe("checkRateLimit with AbortSignal", () => {
  test("aborts during sleep phase (after burst)", async () => {
    await Promise.all(
      Array.from({ length: adaptiveRateLimitDefaults.burst }, () =>
        checkRateLimit(),
      ),
    )

    const ac = new AbortController()
    const start = Date.now()
    setTimeout(() => ac.abort(), 20)

    const err = await checkRateLimit(ac.signal).catch((e: unknown) => e)
    expect((err as Error).name).toBe("AbortError")
    expect(Date.now() - start).toBeLessThan(
      adaptiveRateLimitDefaults.intervalMs,
    )
  })

  test("aborts while waiting for lock", async () => {
    const holdMs = 100
    void holdLimiterLockForTest(holdMs)

    const ac = new AbortController()
    const start = Date.now()
    setTimeout(() => ac.abort(), 20)

    const err = await checkRateLimit(ac.signal).catch((e: unknown) => e)
    expect((err as Error).name).toBe("AbortError")
    expect(Date.now() - start).toBeLessThan(holdMs)
  })

  test("aborted request does not block subsequent requests", async () => {
    const holdMs = 80
    void holdLimiterLockForTest(holdMs)

    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)

    const err = await checkRateLimit(ac.signal).catch((e: unknown) => e)
    expect((err as Error).name).toBe("AbortError")

    await sleep(holdMs + 20)

    const start = Date.now()
    await checkRateLimit()
    expect(Date.now() - start).toBeLessThan(50)
  })
})

describe("rate limiter queue size limit", () => {
  test("throws RateLimitQueueFullError when queue is full", async () => {
    const ac = new AbortController()
    void holdLimiterLockForTest(200)

    const pending: Array<Promise<void>> = []

    for (let i = 0; i < 100; i++) {
      pending.push(checkRateLimit(ac.signal).catch(() => {}))
    }

    const err = await checkRateLimit(ac.signal).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitQueueFullError)

    ac.abort()
    resetAdaptiveRateLimiterForTest()
    await Promise.allSettled(pending)
  })
})
