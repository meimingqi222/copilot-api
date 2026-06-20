import { describe, expect, test } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import { writeSseEvent, writeSseEvents, type SSEStream } from "~/lib/sse"
import { createInitialStreamState } from "~/routes/messages/anthropic-types"
import { translateChunkToAnthropicEvents } from "~/routes/messages/stream-translation"

function createCapturingStream(): SSEStream & {
  frames: Array<string>
  writeCalls: number
  writeSseCalls: number
} {
  const frames: Array<string> = []
  let writeCalls = 0
  let writeSseCalls = 0

  return {
    frames,
    get writeCalls() {
      return writeCalls
    },
    get writeSseCalls() {
      return writeSseCalls
    },
    write(input) {
      writeCalls += 1
      frames.push(
        typeof input === "string" ? input : new TextDecoder().decode(input),
      )
      return Promise.resolve()
    },
    writeSSE(message) {
      writeSseCalls += 1
      const eventLine = message.event ? `event: ${message.event}\n` : ""
      frames.push(`${eventLine}data: ${message.data}\n\n`)
      return Promise.resolve()
    },
  }
}

describe("forwarding performance helpers", () => {
  test("writeSseEvents batches multiple frames into one write call", async () => {
    const stream = createCapturingStream()

    await writeSseEvents(stream, [
      { data: '{"type":"message_start"}', event: "message_start" },
      { data: '{"type":"content_block_delta"}', event: "content_block_delta" },
      { data: '{"type":"message_stop"}', event: "message_stop" },
    ])

    expect(stream.writeCalls).toBe(1)
    expect(stream.writeSseCalls).toBe(0)
    expect(stream.frames).toHaveLength(1)
    expect(stream.frames[0]).toContain("event: message_start")
    expect(stream.frames[0]).toContain("event: message_stop")
  })

  test("writeSseEvents falls back to writeSSE for a single event", async () => {
    const stream = createCapturingStream()

    await writeSseEvents(stream, [{ data: '{"ok":true}', event: "ping" }])

    expect(stream.writeCalls).toBe(0)
    expect(stream.writeSseCalls).toBe(1)
  })

  test("writeSseEvent remains available for single-event paths", async () => {
    const stream = createCapturingStream()

    await writeSseEvent(stream, '{"done":true}', "done")

    expect(stream.writeSseCalls).toBe(1)
    expect(stream.frames[0]).toContain('data: {"done":true}')
  })

  test("anthropic stream translation handles 1000 chunks within reasonable time", () => {
    const chunk: ChatCompletionChunk = {
      id: "cmpl-perf",
      object: "chat.completion.chunk",
      created: 1,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          delta: { content: "x" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const streamState = createInitialStreamState()
    const startedAt = performance.now()

    for (let index = 0; index < 1000; index += 1) {
      translateChunkToAnthropicEvents(chunk, streamState)
    }

    const elapsedMs = performance.now() - startedAt
    expect(elapsedMs).toBeLessThan(500)
  })
})
