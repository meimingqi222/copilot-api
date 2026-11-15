import { describe, expect, test } from "bun:test"

import { publicUsageResponse } from "~/lib/public-usage"
import { writeSseEvent, writeSseEvents, type SSEStream } from "~/lib/sse"

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
  for (const batched of [false, true]) {
    test(`public SSE strips internal usage without changing standard counters (batch=${batched})`, async () => {
      const stream = createCapturingStream()
      const metadata = {
        context_window: { used_tokens: 55000, max_tokens: 200000 },
        usage_status: "pending",
      }
      const cacheCreation = {
        cache_creation_input_tokens: 200,
        cache_creation: { ephemeral_5m_input_tokens: 200 },
      }
      const chat = {
        prompt_tokens: 1000,
        completion_tokens: 70,
        total_tokens: 1070,
        prompt_tokens_details: { cached_tokens: 600, audio_tokens: 11 },
        completion_tokens_details: { reasoning_tokens: 43 },
      }
      const messages = {
        input_tokens: 200,
        output_tokens: 70,
        cache_read_input_tokens: 600,
        ...cacheCreation,
        server_tool_use: { web_search_requests: 1 },
        service_tier: "standard",
      }
      const responses = {
        input_tokens: 1000,
        output_tokens: 70,
        total_tokens: 1070,
        input_tokens_details: { cached_tokens: 600 },
        output_tokens_details: { reasoning_tokens: 43 },
      }
      const geminiUsage = {
        promptTokenCount: 1000,
        candidatesTokenCount: 70,
        totalTokenCount: 1070,
        cachedContentTokenCount: 600,
        thoughtsTokenCount: 43,
      }
      const payloads = [
        {
          usage: {
            ...chat,
            ...metadata,
            prompt_tokens_details: {
              ...chat.prompt_tokens_details,
              ...cacheCreation,
            },
          },
        },
        {
          type: "message_start",
          message: { usage: { ...messages, ...metadata } },
        },
        {
          type: "message_delta",
          usage: { input_tokens: 0, output_tokens: 0, ...metadata },
        },
        {
          type: "response.completed",
          response: {
            usage: {
              ...responses,
              ...metadata,
              input_tokens_details: {
                ...responses.input_tokens_details,
                ...cacheCreation,
              },
            },
          },
        },
        {
          usageMetadata: {
            ...geminiUsage,
            ...metadata,
          },
        },
      ]
      const events = payloads.map((payload) => ({
        data: JSON.stringify(payload),
      }))
      if (batched) await writeSseEvents(stream, events)
      else for (const event of events) await writeSseEvent(stream, event.data)

      const sent = stream.frames
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
      expect(sent).toEqual([
        { usage: chat },
        { type: "message_start", message: { usage: messages } },
        { type: "message_delta", usage: { input_tokens: 0, output_tokens: 0 } },
        { type: "response.completed", response: { usage: responses } },
        { usageMetadata: geminiUsage },
      ])
      expect(payloads[0].usage?.usage_status).toBe("pending")
      expect(
        publicUsageResponse(payloads[4] as Record<string, unknown>),
      ).toEqual({
        usageMetadata: geminiUsage,
      })
    })
  }

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
})
