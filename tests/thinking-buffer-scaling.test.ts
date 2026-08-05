/**
 * Regression tests for quadratic growth in the streaming size guards.
 *
 * The MAX_* byte limits were originally enforced by re-measuring the whole
 * accumulated string on every delta (`Buffer.byteLength(state.bufferedThinking)`).
 * Each call flattens the accumulated rope, so a stream of N reasoning deltas
 * reallocated the entire buffer N times — O(n^2) time and allocation.
 *
 * This hit Windsurf hardest: it sends its reasoning signature only in the final
 * frame, so the whole reasoning stream stays in `bufferedThinking` and every
 * single delta pays the full re-measure. A few MB of thinking was enough to
 * churn through GBs of string allocation and exhaust the heap.
 */
import { describe, expect, test } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  createInitialStreamState,
  translateChunkToAnthropicEvents,
} from "~/services/protocols/anthropic"

const THINKING_DELTA = "让我仔细分析一下这个问题。"

function reasoningChunk(text: string): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "swe-1",
    choices: [
      {
        index: 0,
        delta: { reasoning_text: text },
        finish_reason: null,
      },
    ],
  } as ChatCompletionChunk
}

/**
 * Drive an unsigned reasoning stream (Windsurf shape) and return elapsed ms.
 */
function streamReasoning(deltaCount: number): {
  elapsedMs: number
  bufferedBytes: number
} {
  const state = createInitialStreamState()
  const start = performance.now()
  for (let i = 0; i < deltaCount; i++) {
    translateChunkToAnthropicEvents(reasoningChunk(THINKING_DELTA), state)
  }
  const elapsedMs = performance.now() - start
  return { elapsedMs, bufferedBytes: Buffer.byteLength(state.bufferedThinking) }
}

describe("unsigned thinking buffer scaling", () => {
  test("accumulates the full reasoning text", () => {
    const state = createInitialStreamState()
    for (let i = 0; i < 100; i++) {
      translateChunkToAnthropicEvents(reasoningChunk(THINKING_DELTA), state)
    }
    expect(state.bufferedThinking).toBe(THINKING_DELTA.repeat(100))
    expect(state.bufferedThinkingBytes).toBe(
      Buffer.byteLength(THINKING_DELTA) * 100,
    )
  })

  test("handles a multi-MB reasoning stream without quadratic blowup", () => {
    // Warm up so JIT compilation is not attributed to the measured run.
    streamReasoning(2_000)

    // 40k deltas ≈ 1.5MB of thinking — a normal "long thinking" Windsurf turn.
    const { elapsedMs, bufferedBytes } = streamReasoning(40_000)

    expect(bufferedBytes).toBe(Buffer.byteLength(THINKING_DELTA) * 40_000)

    // Linear: ~7ms on a dev machine. Quadratic: ~1400ms, and it allocates
    // ~30GB of intermediate strings on the way. The 500ms bound leaves ~70x
    // headroom for slow/loaded CI while still catching the regression by ~3x.
    expect(elapsedMs).toBeLessThan(500)
  })
})
