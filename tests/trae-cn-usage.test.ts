import { expect, test } from "bun:test"

import {
  traeCnCollect,
  traeCnParts,
  traeCnSse,
  traeCnStreamEvents,
} from "~/services/trae-cn/client"

function parts(usage: Record<string, unknown>) {
  const sse = `event: token_usage\ndata: ${JSON.stringify(usage)}\n\nevent: done\ndata: {}\n\n`
  return traeCnParts(traeCnSse(new Response(sse).body!))
}

const usage = {
  prompt_tokens: 1000,
  completion_tokens: 200,
  total_tokens: 1200,
  cache_read_input_tokens: 400,
  cache_creation_input_tokens: 100,
  reasoning_tokens: 50,
}
const expected = {
  prompt_tokens: 1000,
  completion_tokens: 200,
  total_tokens: 1200,
  prompt_tokens_details: {
    cached_tokens: 400,
    cache_creation_input_tokens: 100,
  },
  completion_tokens_details: { reasoning_tokens: 50 },
}

test("Trae cache read/write and reasoning counts survive non-streaming collection", async () => {
  const result = await traeCnCollect(parts(usage), "test-model")
  expect(result.usage).toEqual(expected)
})

test("Trae cache read/write and reasoning counts survive streaming usage output", async () => {
  const emitted = []
  for await (const event of traeCnStreamEvents(parts(usage), "test-model")) {
    if (event.data === "[DONE]") continue
    const chunk = JSON.parse(event.data) as { usage?: unknown }
    if (chunk.usage) emitted.push(chunk.usage)
  }
  expect(emitted).toEqual([expected])
})

test("absent Trae cache metrics remain absent rather than being reported as measured zero", async () => {
  const result = await traeCnCollect(
    parts({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }),
    "test-model",
  )
  expect(result.usage).toEqual({
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
  })
})

test("live Doubao token_usage preserves explicit zero cache counters and reasoning", async () => {
  const result = await traeCnCollect(
    parts({
      prompt_tokens: 51,
      completion_tokens: 235,
      total_tokens: 286,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      reasoning_tokens: 234,
    }),
    "Doubao-Seed-Evolving",
  )
  expect(result.usage).toEqual({
    prompt_tokens: 51,
    completion_tokens: 235,
    total_tokens: 286,
    prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 234 },
  })
})
