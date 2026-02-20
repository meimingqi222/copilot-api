import { afterEach, describe, expect, test } from "bun:test"

import {
  adaptiveRateLimitDefaults,
  checkRateLimit,
  reportUpstreamRateLimit,
  resetAdaptiveRateLimiterForTest,
} from "~/lib/rate-limit"

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
