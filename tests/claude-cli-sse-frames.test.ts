/**
 * Regression lock for the Claude CLI transport's streaming frame shape.
 *
 * `translateClaudeStreamJson` yields *typed* Anthropic events
 * (`{ type, index, delta, … }`), while the `/v1/messages` streaming consumer
 * (`routes/messages/connection-handler.ts`) only forwards SSE frames that carry
 * a `.data` string — `if (!event.data) continue` plus `forwardSseEvent`'s own
 * `if (!event.data) return`.
 *
 * Before the fix the CLI branch handed the typed events straight to the route,
 * so every single event was dropped: a real-machine run returned `HTTP 200` and
 * nothing but the `: connected` keep-alive comment, while the non-streaming path
 * (which never goes through the frame contract) worked fine.
 *
 * These tests pin the boundary: whatever the CLI emits must arrive as
 * `{ data: <json>, event: <type> }`.
 */

import { describe, expect, test } from "bun:test"

import { cliEventsAsSseFrames } from "~/services/claude/create-messages-once"
import type { AnthropicStreamEventData } from "~/services/protocols/anthropic/types"

const TYPED_EVENTS: Array<AnthropicStreamEventData> = [
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "1" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: " 2" },
  },
  { type: "message_stop" },
]

async function collect(
  events: Array<AnthropicStreamEventData>,
): Promise<Array<{ data: string; event: string }>> {
  const frames: Array<{ data: string; event: string }> = []
  for await (const frame of cliEventsAsSseFrames(
    (async function* generate() {
      for (const event of events) yield event
    })(),
  )) {
    frames.push(frame)
  }
  return frames
}

describe("cliEventsAsSseFrames", () => {
  /**
   * The route drops any frame without a `.data` string. If a future refactor
   * returns typed events again, this fails instead of silently producing an
   * empty stream.
   */
  test("puts a non-empty `data` string on every frame", async () => {
    const frames = await collect(TYPED_EVENTS)
    expect(frames).toHaveLength(TYPED_EVENTS.length)
    for (const frame of frames) {
      expect(typeof frame.data).toBe("string")
      expect(frame.data.length).toBeGreaterThan(0)
    }
  })

  test("names the SSE event after the Anthropic event type", async () => {
    const frames = await collect(TYPED_EVENTS)
    expect(frames.map((frame) => frame.event)).toEqual([
      "content_block_delta",
      "content_block_delta",
      "message_stop",
    ])
  })

  test("keeps the event payload JSON-parseable in the original order", async () => {
    const frames = await collect(TYPED_EVENTS)
    expect(frames.map((frame) => JSON.parse(frame.data))).toEqual(TYPED_EVENTS)
  })
})
