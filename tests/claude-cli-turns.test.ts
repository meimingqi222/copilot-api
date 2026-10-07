import { describe, expect, test } from "bun:test"
import { normalizeClaudeTurns } from "~/services/claude/cli/turns"
import {
  collectAnthropicResponse,
  translateClaudeStreamJson,
} from "~/services/claude/cli/translate"
import { readClaudeSearchResults } from "~/services/claude/cli/search-results"
import { RunRegistry } from "~/services/claude/cli/run-registry"
import { encodeChatTextFormat } from "~/services/ir/codecs/messages-chat/text-format"
import type { ClaudeStreamJsonEvent } from "~/services/claude/cli/stream-json"
import { drain } from "./claude-cli-fixtures"

async function* lines(values: Array<unknown>): AsyncIterable<string> {
  for (const value of values) yield JSON.stringify(value)
}
function event(value: ClaudeStreamJsonEvent): unknown {
  return { type: "stream_event", event: value }
}
function turn(name: string, stop = "tool_use"): Array<unknown> {
  return [
    event({
      type: "message_start",
      message: { id: "msg", usage: { input_tokens: 10, output_tokens: 1 } },
    }),
    event({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call", name },
    }),
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    }),
    event({ type: "content_block_stop", index: 0 }),
    event({
      type: "message_delta",
      delta: { stop_reason: stop },
      usage: { output_tokens: 5 },
    }),
    event({ type: "message_stop" }),
  ]
}
async function translate(values: Array<unknown>, structured = false) {
  return drain(
    translateClaudeStreamJson(
      normalizeClaudeTurns(lines(values), { structured }),
      { model: "claude-test" },
    ),
  )
}

describe("CLI internal turn normalization", () => {
  test("associates parallel search results by tool use ID even out of order", async () => {
    const values = [
      event({ type: "message_start", message: { id: "parallel", usage: {} } }),
      ...["A", "B"].flatMap((id, index) => [
        event({
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id, name: "WebSearch" },
        }),
        event({ type: "content_block_stop", index }),
      ]),
      ...["B", "A"].map((id) => ({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id }] },
        tool_use_result: {
          query: `query-${id}`,
          results: [
            { content: [{ url: `https://${id.toLowerCase()}.example` }] },
          ],
        },
      })),
      { type: "result", is_error: false },
    ]
    const response = await collectAnthropicResponse(
      (async function* () {
        yield* await translate(values)
      })(),
      "test",
    )
    const calls = response.content.filter(
      (block) => block.type === "server_tool_use",
    )
    expect(calls.map((block) => [block.id, block.input.query])).toEqual([
      ["B", "query-B"],
      ["A", "query-A"],
    ])
    expect(
      response.content
        .filter((block) => block.type === "web_search_tool_result")
        .map((block) => block.tool_use_id),
    ).toEqual(["B", "A"])
  })
  test("folds wait and search rounds and sums usage without a result usage", async () => {
    const events = await translate([
      ...turn("mcp__copilotapi__wait_for_tool"),
      ...turn("WebSearch"),
      event({ type: "message_start", message: { usage: { input_tokens: 3 } } }),
      event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "answer" },
      }),
      event({ type: "content_block_stop", index: 0 }),
      event({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      }),
      event({ type: "message_stop" }),
      { type: "result", is_error: false },
    ])
    expect(events.filter((item) => item.type === "message_start")).toHaveLength(
      1,
    )
    expect(events.filter((item) => item.type === "message_stop")).toHaveLength(
      1,
    )
    expect(
      events.filter((item) => item.type === "content_block_start"),
    ).toHaveLength(1)
    expect(events.find((item) => item.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 23, output_tokens: 12 },
    })
  })
  test("keeps caller tools visible while using a JSON schema", async () => {
    const events = await translate(turn("mcp__copilotapi__get_weather"), true)
    expect(
      events.find((item) => item.type === "content_block_start"),
    ).toMatchObject({
      content_block: { type: "tool_use", name: "get_weather" },
    })
    expect(events.find((item) => item.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "tool_use" },
    })
    expect(events.filter((item) => item.type === "message_stop")).toHaveLength(
      1,
    )
  })
  test("does not accept prose when the final schema result is missing", async () => {
    const events = await translate(
      [...turn("StructuredOutput"), { type: "result", is_error: false }],
      true,
    )
    expect(events.find((item) => item.type === "error")).toMatchObject({
      error: {
        message:
          "Claude Code ended the turn without an answer fitting the schema",
      },
    })
    expect(events.some((item) => item.type === "content_block_start")).toBe(
      false,
    )
  })
  test("reports an incomplete structured stream instead of a successful empty answer", async () => {
    const events = await translate(turn("StructuredOutput"), true)
    expect(events.some((item) => item.type === "error")).toBe(true)
    expect(events.at(-1)?.type).toBe("message_stop")
  })
  test("ends an error envelope even while the CLI process stays alive", async () => {
    const events = await translate([
      { type: "result", is_error: true, result: "usage limit reached" },
    ])
    expect(events.map((item) => item.type)).toEqual([
      "message_start",
      "error",
      "message_delta",
      "message_stop",
    ])
  })
  test("folds server search results into the non-streaming response", async () => {
    const response = await collectAnthropicResponse(
      translateClaudeStreamJson(
        normalizeClaudeTurns(
          lines([
            ...turn("WebSearch"),
            {
              type: "user",
              message: {
                content: [{ type: "tool_result", tool_use_id: "call" }],
              },
              tool_use_result: {
                query: "question",
                results: [
                  {
                    content: [
                      { url: "https://example.invalid", title: "title" },
                    ],
                  },
                ],
              },
            },
            { type: "result", is_error: false },
          ]),
          { structured: false },
        ),
        { model: "claude-test" },
      ),
      "claude-test",
    )
    expect(response.content.map((block) => block.type)).toEqual([
      "server_tool_use",
      "web_search_tool_result",
    ])
  })
  test("accepts empty search results and ignores malformed entries", () => {
    expect(readClaudeSearchResults({ query: "question", results: [] })).toEqual(
      { query: "question", content: [] },
    )
    expect(readClaudeSearchResults({ query: 1, results: [] })).toBeUndefined()
    expect(
      readClaudeSearchResults({
        query: "question",
        results: [
          { content: [null, { url: 123 }, { url: "https://example.invalid" }] },
        ],
      })?.content,
    ).toHaveLength(1)
  })
})

describe("CLI resource reservations", () => {
  test("provides a valid OpenAI schema name for Messages and bare schema formats", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } }
    for (const jsonSchema of [schema, { schema }]) {
      expect(encodeChatTextFormat({ type: "json_schema", jsonSchema })).toEqual(
        {
          response_format: {
            type: "json_schema",
            json_schema: { name: "response", schema },
          },
        },
      )
    }
  })
  test("accounts for concurrent startup before a subprocess is registered", () => {
    const registry = new RunRegistry()
    const release = registry.reserveConnection("connection", 1)
    expect(release).toBeDefined()
    expect(registry.countForConnection("connection")).toBe(1)
    expect(registry.reserveConnection("connection", 1)).toBeUndefined()
    release?.()
    expect(registry.countForConnection("connection")).toBe(0)
    expect(registry.reserveConnection("connection", 1)).toBeDefined()
  })
})
