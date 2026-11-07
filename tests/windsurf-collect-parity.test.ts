import { describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"
import type { WindsurfStreamEvent } from "~/services/windsurf/collect-response"

import { clearDevinUserJwtCacheForTest } from "~/services/windsurf/auth"
import {
  chunkFromText,
  chunkFromToolCallArgs,
  chunkFromToolCallInit,
  doneChunk,
} from "~/services/windsurf/chunk-builders"
import { collectChatCompletion } from "~/services/windsurf/collect-response"
import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"
import {
  encodeConnectFrame,
  ProtobufEncoder,
} from "~/services/windsurf/protobuf"

/**
 * The non-streaming collector reads the structured `collected` twin that
 * `streamToOpenAI` attaches, instead of re-parsing the SSE JSON it had just
 * serialized. The two must stay interchangeable — this feeds the identical
 * event sequence both ways and requires byte-identical results.
 */
const REQ = "chatcmpl-test"
const MODEL = "swe-1-7"

function buildEvents(): Array<WindsurfStreamEvent> {
  const usage = {
    prompt_tokens: 120,
    completion_tokens: 34,
    total_tokens: 154,
    cached_tokens: 90,
    cache_read_tokens: 90,
    cache_write_tokens: 10,
  }
  return [
    {
      data: chunkFromText({
        requestId: REQ,
        model: MODEL,
        text: "thinking hard",
        field: "reasoning_text",
      }),
      collected: { reasoningText: "thinking hard" },
    },
    {
      data: chunkFromText({
        requestId: REQ,
        model: MODEL,
        text: "SIG",
        field: "reasoning_opaque",
      }),
      collected: { reasoningOpaque: "SIG" },
    },
    {
      data: chunkFromText({
        requestId: REQ,
        model: MODEL,
        text: "Hello ",
        field: "content",
      }),
      collected: { content: "Hello " },
    },
    {
      data: chunkFromText({
        requestId: REQ,
        model: MODEL,
        text: "世界🎉",
        field: "content",
      }),
      collected: { content: "世界🎉" },
    },
    {
      data: chunkFromToolCallInit({
        requestId: REQ,
        model: MODEL,
        toolIndex: 0,
        callId: "call_1",
        toolName: "bash",
      }),
      collected: {
        toolCalls: [
          { index: 0, id: "call_1", function: { name: "bash", arguments: "" } },
        ],
      },
    },
    {
      data: chunkFromToolCallArgs({
        requestId: REQ,
        model: MODEL,
        toolIndex: 0,
        args: '{"cmd":',
      }),
      collected: {
        toolCalls: [{ index: 0, function: { arguments: '{"cmd":' } }],
      },
    },
    {
      data: chunkFromToolCallArgs({
        requestId: REQ,
        model: MODEL,
        toolIndex: 0,
        args: '"ls"}',
      }),
      collected: {
        toolCalls: [{ index: 0, function: { arguments: '"ls"}' } }],
      },
    },
    {
      data: doneChunk({
        requestId: REQ,
        model: MODEL,
        finishReason: "tool_calls",
        usage,
      }),
      collected: {
        finishReason: "tool_calls",
        usage: {
          prompt_tokens: 120,
          completion_tokens: 34,
          total_tokens: 154,
          prompt_tokens_details: {
            cached_tokens: 90,
            cache_creation_input_tokens: 10,
          },
        },
      },
    },
    { data: "[DONE]" },
  ]
}

function toStream(
  events: Array<WindsurfStreamEvent>,
): AsyncIterable<WindsurfStreamEvent> {
  // Sync generator is sufficient (no upstream I/O); `for await` accepts it.
  return (function* () {
    for (const event of events) yield event
  })() as unknown as AsyncIterable<WindsurfStreamEvent>
}

describe("windsurf non-streaming collector", () => {
  test.each([false, true])(
    "actual adapter normalizes interleaved tool snapshots and incremental args (stream=%s)",
    async (stream) => {
      const originalFetch = globalThis.fetch
      const connection: ProviderConnection = {
        id: "windsurf-tool-deltas",
        name: "windsurf-tool-deltas",
        protocol: "windsurf-native",
        baseUrl: "",
        enabled: true,
        priority: 0,
        createdAt: 0,
        metadata: {
          provider: "windsurf",
          settings: { baseUrl: "https://windsurf.test" },
        },
        credentials: [
          {
            id: "windsurf-tool-deltas",
            authMode: "bearer",
            value: "test-key",
            enabled: true,
            status: "ready",
            createdAt: 0,
          },
        ],
      }
      const toolFrame = (id?: string, name?: string, args?: string) => {
        const call = new ProtobufEncoder()
        if (id !== undefined) call.writeString(1, id)
        if (name !== undefined) call.writeString(2, name)
        if (args !== undefined) call.writeString(3, args)
        const frame = new ProtobufEncoder()
        frame.writeMessage(6, call)
        return encodeConnectFrame(frame.toUint8Array(), false)
      }
      const finish = new ProtobufEncoder()
      finish.writeVarint(5, 10)
      const eos = encodeConnectFrame(new TextEncoder().encode("{}"), false)
      eos[0] = 2
      const body = Buffer.concat([
        toolFrame("call_a", "search", '{"query":'),
        toolFrame("call_b", "read", '{"path":'),
        toolFrame("call_a", "search", '{"query":"hel'),
        toolFrame("call_a", "search", '{"query":"hel'),
        toolFrame("call_a", undefined, '{"query":"hello"}'),
        toolFrame("call_b", undefined, '"x'),
        toolFrame(undefined, undefined, 'y"}'),
        toolFrame("call_a", "search", '{"query":"hello"}'),
        toolFrame("call_c", "empty", "{}"),
        encodeConnectFrame(finish.toUint8Array(), false),
        eos,
      ])
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input)
        if (!url.includes("GetUserJwt")) return new Response(body)
        const auth = new ProtobufEncoder()
        auth.writeString(1, "test-jwt")
        return new Response(auth.toUint8Array())
      }) as typeof fetch
      try {
        const result = await createWindsurfChatCompletionsOnce(
          { connection, credential: connection.credentials[0] },
          {
            model: MODEL,
            messages: [{ role: "user", content: "use tools" }],
            tools: ["search", "read", "empty"].map((name) => ({
              type: "function" as const,
              function: { name, parameters: { type: "object" } },
            })),
            stream,
          },
        )
        let collected
        if (Symbol.asyncIterator in result) {
          const events: Array<WindsurfStreamEvent> = []
          for await (const event of result) events.push(event)
          const calls = events.flatMap((event) => {
            if (!event.data || event.data === "[DONE]") return []
            const chunk = JSON.parse(event.data) as {
              choices: Array<{
                delta: {
                  tool_calls?: Array<{
                    index: number
                    id?: string
                    function: { arguments: string }
                  }>
                }
              }>
            }
            return chunk.choices[0].delta.tool_calls ?? []
          })
          expect(
            calls
              .filter((call) => call.id)
              .map(({ index, id }) => ({ index, id })),
          ).toEqual([
            { index: 0, id: "call_a" },
            { index: 1, id: "call_b" },
            { index: 2, id: "call_c" },
          ])
          expect(
            calls
              .filter((call) => !call.id)
              .map((call) => [call.index, call.function.arguments]),
          ).toEqual([
            [0, '{"query":'],
            [1, '{"path":'],
            [0, '"hel'],
            [0, 'lo"}'],
            [1, '"x'],
            [1, 'y"}'],
            [2, "{}"],
          ])
          collected = await collectChatCompletion(toStream(events), MODEL)
        } else collected = result
        expect(collected.choices[0].finish_reason).toBe("tool_calls")
        expect(collected.choices[0].message.tool_calls).toEqual([
          {
            id: "call_a",
            type: "function",
            function: { name: "search", arguments: '{"query":"hello"}' },
          },
          {
            id: "call_b",
            type: "function",
            function: { name: "read", arguments: '{"path":"xy"}' },
          },
          {
            id: "call_c",
            type: "function",
            function: { name: "empty", arguments: "{}" },
          },
        ])
      } finally {
        globalThis.fetch = originalFetch
        clearDevinUserJwtCacheForTest()
      }
    },
  )

  test("structured `collected` path matches the JSON fallback exactly", async () => {
    const events = buildEvents()

    const structured = await collectChatCompletion(toStream(events), MODEL)
    // Strip the twin so the collector is forced through JSON.parse(event.data).
    const stripped = events.map(({ data }) => ({ data }))
    const viaJson = await collectChatCompletion(toStream(stripped), MODEL)

    // `created` is a wall-clock second and may straddle a tick.
    const normalize = (r: typeof structured) => ({ ...r, created: 0, id: "" })
    expect(normalize(structured)).toEqual(normalize(viaJson))

    // And the collected content itself is correct, not just self-consistent.
    expect(structured.choices[0].message.content).toBe("Hello 世界🎉")
    expect(structured.choices[0].finish_reason).toBe("tool_calls")
    expect(structured.choices[0].message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "bash", arguments: '{"cmd":"ls"}' },
      },
    ])
    expect(structured.usage).toMatchObject({
      prompt_tokens: 120,
      completion_tokens: 34,
      prompt_tokens_details: { cached_tokens: 90 },
    })
  })
  test.each(["tools", "mixed"])(
    "enforces one response budget across %s",
    async (mode) => {
      const chunk = "x".repeat(64 * 1024)
      async function* events(): AsyncIterable<WindsurfStreamEvent> {
        for (let index = 0; index < 2; index++) {
          yield {
            data: "{}",
            collected: {
              toolCalls: [
                {
                  index,
                  id: `call_${index}`,
                  function: { name: "write", arguments: "" },
                },
              ],
            },
          }
          for (let i = 0; i < 257; i++) {
            yield {
              data: "{}",
              collected:
                mode === "mixed" && index === 0 ?
                  { content: chunk }
                : { toolCalls: [{ index, function: { arguments: chunk } }] },
            }
          }
        }
      }
      const outcome = await collectChatCompletion(events(), MODEL).then(
        () => "accepted",
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      )
      expect(outcome).toBe("Windsurf response exceeds the maximum size")
    },
  )
  test("bounds empty tool calls as well as their byte budget", async () => {
    let closed = false
    async function* events(): AsyncIterable<WindsurfStreamEvent> {
      try {
        for (let index = 0; index <= 8192; index++)
          yield {
            data: "{}",
            collected: {
              toolCalls: [
                {
                  index,
                  id: `c${index}`,
                  function: { name: "t", arguments: "" },
                },
              ],
            },
          }
      } finally {
        closed = true
      }
    }
    await expect(collectChatCompletion(events(), MODEL)).rejects.toThrow(
      "maximum tool count",
    )
    expect(closed).toBe(true)
  })
})
