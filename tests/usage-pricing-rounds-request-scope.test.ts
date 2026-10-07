import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  bindRequestLogContext,
  createDetachedRequestLog,
} from "~/lib/request-log"
import {
  createUsagePricingRecorder,
  takeUsagePricingRounds,
} from "~/lib/usage-pricing-rounds"

describe("usage pricing round request ownership", () => {
  test("a failed turn cannot price a later native turn on the same account", async () => {
    const app = new Hono()
    app.get("/", (c) => {
      bindRequestLogContext(c, createDetachedRequestLog())
      const abandonedRecorder = createUsagePricingRecorder(c, "account")
      abandonedRecorder({
        source: "reported",
        inputTokens: 300_000,
        outputTokens: 100,
      })

      // No usage consumption: the first WS turn failed before its terminal frame.
      bindRequestLogContext(c, createDetachedRequestLog())
      expect(takeUsagePricingRounds(c, "account")).toBeUndefined()
      expect(takeUsagePricingRounds(c, "account")).toBeUndefined()

      const currentRecorder = createUsagePricingRecorder(c, "account")
      currentRecorder({
        source: "reported",
        inputTokens: 100,
        outputTokens: 10,
      })
      // Late callbacks from the failed generator cannot replace current rounds.
      abandonedRecorder({
        source: "reported",
        inputTokens: 400_000,
        outputTokens: 200,
      })
      expect(takeUsagePricingRounds(c, "account")).toEqual([
        {
          promptTokens: 100,
          completionTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      ])
      expect(takeUsagePricingRounds(c, "account")).toBeUndefined()
      return c.text("ok")
    })
    expect((await app.request("/")).status).toBe(200)
  })

  test("a different account cannot consume rounds from the same request", async () => {
    const app = new Hono()
    app.get("/", (c) => {
      bindRequestLogContext(c, createDetachedRequestLog())
      createUsagePricingRecorder(
        c,
        "first",
      )({
        source: "reported",
        inputTokens: 100,
      })
      expect(takeUsagePricingRounds(c, "second")).toBeUndefined()
      expect(takeUsagePricingRounds(c, "first")).toBeUndefined()
      return c.text("ok")
    })
    expect((await app.request("/")).status).toBe(200)
  })
})
