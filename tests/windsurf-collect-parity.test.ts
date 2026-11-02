import { describe, expect, test } from "bun:test"

import type { WindsurfStreamEvent } from "~/services/windsurf/collect-response"

import {
  chunkFromText,
  chunkFromToolCallArgs,
  chunkFromToolCallInit,
  doneChunk,
} from "~/services/windsurf/chunk-builders"
import { collectChatCompletion } from "~/services/windsurf/collect-response"

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
