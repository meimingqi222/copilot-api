import { expect, test } from "bun:test"
import { computePerformanceBundle } from "~/lib/stats/performance-bundle"
import { runPerformanceBundle } from "~/lib/stats/performance-runner"
import type { UsageRawRow } from "~/lib/stats/types"

test("large aggregation keeps the event loop responsive and matches the synchronous result", async () => {
  const rows: UsageRawRow[] = Array.from({ length: 10_000 }, (_, i) => ({
    model: "worker-model",
    account_id: "worker",
    user_id: null,
    provider: "copilot",
    prompt_tokens: 10,
    completion_tokens: 30,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 40,
    cost: 0,
    timestamp: i,
    ttft_ms: i % 100,
    tps: 30,
    streaming: 1,
    performance_json: JSON.stringify({
      version: 1,
      endpoint: "/v1/messages",
      transport: "http",
      translated: false,
      generationMs: 1000,
      preprocessingMs: i % 77,
    }),
  }))
  let timerRan = false
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      timerRan = true
      resolve()
    }, 0),
  )
  const job = runPerformanceBundle(rows)
  let finished = false
  void job.then(() => {
    finished = true
  })
  await timer
  expect(timerRan).toBe(true)
  expect(finished).toBe(false)
  expect(await job).toEqual(computePerformanceBundle(rows))
})
