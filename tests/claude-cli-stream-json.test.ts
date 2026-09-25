import { describe, expect, test } from "bun:test"

import type { AnthropicStreamEventData } from "~/services/protocols/anthropic/types"

import {
  parseStreamJsonLine,
  readStreamJsonLines,
} from "~/services/claude/cli/stream-json"
import {
  collectAnthropicResponse,
  translateClaudeStreamJson,
} from "~/services/claude/cli/translate"

async function* fromArray<T>(items: Array<T>): AsyncIterable<T> {
  for (const item of items) yield item
}

async function translate(
  lines: Array<string>,
  options: { model?: string } = {},
): Promise<Array<AnthropicStreamEventData>> {
  const out: Array<AnthropicStreamEventData> = []
  for await (const event of translateClaudeStreamJson(fromArray(lines), {
    model: options.model ?? "claude-sonnet-4-6",
  })) {
    out.push(event)
  }
  return out
}

function line(value: unknown): string {
  return JSON.stringify(value)
}

/** A minimal but realistic text turn as Claude Code emits it. */
const TEXT_TURN = [
  line({
    type: "system",
    subtype: "init",
    session_id: "sess_1",
  }),
  line({
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
        },
      },
    },
  }),
  line({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  }),
  line({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi" },
    },
  }),
  line({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " there" },
    },
  }),
  line({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  }),
  line({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 7 },
    },
  }),
  line({ type: "stream_event", event: { type: "message_stop" } }),
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Hi there",
  }),
]

// ── parseStreamJsonLine ─────────────────────────────────────────────────────

describe("parseStreamJsonLine", () => {
  test("parses an object line", () => {
    expect(parseStreamJsonLine('{"type":"result"}')).toEqual({ type: "result" })
  })

  test("tolerates surrounding whitespace", () => {
    expect(parseStreamJsonLine('  {"type":"result"}  ')).toEqual({
      type: "result",
    })
  })

  test("returns undefined for blank lines", () => {
    expect(parseStreamJsonLine("")).toBeUndefined()
    expect(parseStreamJsonLine("   ")).toBeUndefined()
  })

  test("returns undefined for non-JSON noise", () => {
    expect(parseStreamJsonLine("warning: something")).toBeUndefined()
  })

  test("returns undefined for non-object JSON", () => {
    expect(parseStreamJsonLine("[1,2,3]")).toBeUndefined()
    expect(parseStreamJsonLine('"a string"')).toBeUndefined()
    expect(parseStreamJsonLine("null")).toBeUndefined()
  })
})

// ── readStreamJsonLines ─────────────────────────────────────────────────────

describe("readStreamJsonLines", () => {
  test("splits whole lines", async () => {
    const lines: Array<string> = []
    for await (const l of readStreamJsonLines(fromArray(["a\nb\nc\n"]))) {
      lines.push(l)
    }
    expect(lines).toEqual(["a", "b", "c"])
  })

  test("reassembles a line split across chunks", async () => {
    const lines: Array<string> = []
    for await (const l of readStreamJsonLines(
      fromArray(['{"type":"res', 'ult"}\n{"type":"x"}\n']),
    )) {
      lines.push(l)
    }
    expect(lines).toEqual(['{"type":"result"}', '{"type":"x"}'])
  })

  test("emits a trailing line with no newline", async () => {
    const lines: Array<string> = []
    for await (const l of readStreamJsonLines(fromArray(["a\nb"]))) {
      lines.push(l)
    }
    expect(lines).toEqual(["a", "b"])
  })

  test("decodes utf-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode("héllo\n")
    const lines: Array<string> = []
    for await (const l of readStreamJsonLines(
      fromArray([bytes.slice(0, 2), bytes.slice(2)]),
    )) {
      lines.push(l)
    }
    expect(lines).toEqual(["héllo"])
  })
})

// ── translateClaudeStreamJson ───────────────────────────────────────────────

describe("translateClaudeStreamJson", () => {
  test("emits a well-formed text turn", async () => {
    const events = await translate(TEXT_TURN)
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    const text = events
      .filter((event) => event.type === "content_block_delta")
      .map((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "text_delta"
        ) ?
          event.delta.text
        : "",
      )
      .join("")
    expect(text).toBe("Hi there")
  })

  test("rewrites the model to the one the caller asked for", async () => {
    const events = await translate(TEXT_TURN, { model: "claude-opus-4-6" })
    const start = events.find((event) => event.type === "message_start")
    expect(
      start?.type === "message_start" ? start.message.model : undefined,
    ).toBe("claude-opus-4-6")
  })

  test("maps the cache usage fields through", async () => {
    const events = await translate(TEXT_TURN)
    const start = events.find((event) => event.type === "message_start")
    const usage = start?.type === "message_start" ? start.message.usage : null
    expect(usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
    })
  })

  test("carries the stop reason from message_delta", async () => {
    const events = await translate(TEXT_TURN)
    const delta = events.find((event) => event.type === "message_delta")
    expect(
      delta?.type === "message_delta" ? delta.delta.stop_reason : undefined,
    ).toBe("end_turn")
  })

  test("strips the MCP server prefix from a tool name", async () => {
    const events = await translate([
      line({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "mcp__copilotapi__get_weather",
          },
        },
      }),
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' },
        },
      }),
      line({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }),
    ])
    const start = events.find((event) => event.type === "content_block_start")
    expect(
      start?.type === "content_block_start" ? start.content_block : undefined,
    ).toMatchObject({ type: "tool_use", id: "toolu_1", name: "get_weather" })
  })

  test("leaves a tool name without a prefix alone", async () => {
    const events = await translate([
      line({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "t", name: "get_weather" },
        },
      }),
    ])
    const start = events.find((event) => event.type === "content_block_start")
    expect(
      start?.type === "content_block_start" ? start.content_block : undefined,
    ).toMatchObject({ name: "get_weather" })
  })

  test("turns an errored result envelope into an error event", async () => {
    const events = await translate([
      line({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "Claude AI usage limit reached",
      }),
    ])
    expect(events).toEqual([
      {
        type: "error",
        error: { type: "api_error", message: "Claude AI usage limit reached" },
      },
    ])
  })

  test("ignores non-stream_event envelopes", async () => {
    const events = await translate([
      line({ type: "system", subtype: "init" }),
      line({ type: "assistant", message: { content: [] } }),
    ])
    expect(events).toEqual([])
  })

  test("closes an open block before message_delta", async () => {
    const events = await translate([
      line({
        type: "stream_event",
        event: { type: "message_start", message: { id: "m" } },
      }),
      line({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      }),
      line({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        },
      }),
    ])
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })

  test("synthesizes message_stop when the CLI dies mid-turn", async () => {
    const events = await translate([
      line({
        type: "stream_event",
        event: { type: "message_start", message: { id: "m" } },
      }),
      line({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      }),
    ])
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_stop",
      "message_stop",
    ])
  })

  test("emits nothing when the CLI produced no message at all", async () => {
    expect(
      await translate([line({ type: "system", subtype: "init" })]),
    ).toEqual([])
  })

  test("does not double-close a block the CLI already closed", async () => {
    const events = await translate([
      line({
        type: "stream_event",
        event: { type: "message_start", message: { id: "m" } },
      }),
      line({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      }),
      line({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }),
      line({ type: "stream_event", event: { type: "message_stop" } }),
    ])
    expect(
      events.filter((event) => event.type === "content_block_stop"),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === "message_stop"),
    ).toHaveLength(1)
  })

  test("carries an initial text block's text through as a delta", async () => {
    const events = await translate([
      line({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "seed" },
        },
      }),
    ])
    expect(events[1]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "seed" },
    })
  })
})

// ── collectAnthropicResponse ────────────────────────────────────────────────

describe("collectAnthropicResponse", () => {
  test("folds a text turn into a complete response", async () => {
    const response = await collectAnthropicResponse(
      translateClaudeStreamJson(fromArray(TEXT_TURN), {
        model: "claude-sonnet-4-6",
      }),
      "claude-sonnet-4-6",
    )
    expect(response).toMatchObject({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text: "Hi there" }],
    })
    expect(response.usage.output_tokens).toBe(7)
    expect(response.usage.cache_read_input_tokens).toBe(100)
  })

  test("reassembles a tool call's streamed JSON", async () => {
    const response = await collectAnthropicResponse(
      translateClaudeStreamJson(
        fromArray([
          line({
            type: "stream_event",
            event: {
              type: "message_start",
              message: { id: "m", model: "claude-sonnet-4-6" },
            },
          }),
          line({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "toolu_1",
                name: "mcp__copilotapi__get_weather",
              },
            },
          }),
          line({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"city"' },
            },
          }),
          line({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: ':"SF"}' },
            },
          }),
          line({
            type: "stream_event",
            event: { type: "content_block_stop", index: 0 },
          }),
          line({
            type: "stream_event",
            event: {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
            },
          }),
        ]),
        { model: "claude-sonnet-4-6" },
      ),
      "claude-sonnet-4-6",
    )
    expect(response.content).toEqual([
      {
        type: "tool_use",
        id: "toolu_1",
        name: "get_weather",
        input: { city: "SF" },
      },
    ])
    expect(response.stop_reason).toBe("tool_use")
  })

  test("keeps a thinking block and its signature", async () => {
    const response = await collectAnthropicResponse(
      translateClaudeStreamJson(
        fromArray([
          line({
            type: "stream_event",
            event: {
              type: "message_start",
              message: { id: "m", model: "claude-sonnet-4-6" },
            },
          }),
          line({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "" },
            },
          }),
          line({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "hmm" },
            },
          }),
          line({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "signature_delta", signature: "sig" },
            },
          }),
          line({
            type: "stream_event",
            event: { type: "content_block_stop", index: 0 },
          }),
        ]),
        { model: "claude-sonnet-4-6" },
      ),
      "claude-sonnet-4-6",
    )
    expect(response.content).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig" },
    ])
  })

  test("throws when the turn failed before producing any content", async () => {
    await expect(
      collectAnthropicResponse(
        translateClaudeStreamJson(
          fromArray([
            line({
              type: "result",
              is_error: true,
              result: "Claude AI usage limit reached",
            }),
          ]),
          { model: "claude-sonnet-4-6" },
        ),
        "claude-sonnet-4-6",
      ),
    ).rejects.toThrow("Claude AI usage limit reached")
  })

  /**
   * Regression: the CLI's `message_delta` usually carries only output_tokens.
   * Defaulting the missing fields to 0 there used to clobber the real
   * input/cache counts that `message_start` had reported.
   */
  test("message_delta does not clobber the input tokens from message_start", async () => {
    const response = await collectAnthropicResponse(
      translateClaudeStreamJson(
        fromArray([
          line({
            type: "stream_event",
            event: {
              type: "message_start",
              message: {
                id: "m",
                model: "claude-sonnet-4-6",
                usage: {
                  input_tokens: 10,
                  output_tokens: 1,
                  cache_read_input_tokens: 100,
                  cache_creation_input_tokens: 5,
                },
              },
            },
          }),
          line({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          }),
          line({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "ok" },
            },
          }),
          line({
            type: "stream_event",
            event: { type: "content_block_stop", index: 0 },
          }),
          line({
            type: "stream_event",
            event: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 4 },
            },
          }),
        ]),
        { model: "claude-sonnet-4-6" },
      ),
      "claude-sonnet-4-6",
    )
    expect(response.usage).toEqual({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
    })
  })

  test("surfaces a late error as content instead of throwing", async () => {
    const response = await collectAnthropicResponse(
      translateClaudeStreamJson(
        fromArray([
          line({
            type: "stream_event",
            event: {
              type: "message_start",
              message: { id: "m", model: "claude-sonnet-4-6" },
            },
          }),
          line({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          }),
          line({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "partial" },
            },
          }),
          line({
            type: "stream_event",
            event: { type: "content_block_stop", index: 0 },
          }),
          line({ type: "result", is_error: true, result: "stream broke" }),
        ]),
        { model: "claude-sonnet-4-6" },
      ),
      "claude-sonnet-4-6",
    )
    expect(response.content).toEqual([{ type: "text", text: "partial" }])
  })
})
