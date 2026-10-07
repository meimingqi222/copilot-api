import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/services/protocols/anthropic/types"
import {
  collectClaudeCliMessages,
  streamClaudeCliMessages,
  type ClaudeCliRunContext,
} from "~/services/claude/cli/bridge"
import { setClaudeCliTestHooks } from "~/services/claude/cli/binary"
import { runRegistry } from "~/services/claude/cli/run-registry"
import {
  setClaudeCallbackBaseUrl,
  resetClaudeCallbackBaseUrlForTest,
} from "~/services/claude/cli/server-address"
import { claudeCliArgs } from "~/services/claude/cli/args"
import { continuation, sessionKey } from "~/services/claude/cli/session"
import { collectAnthropicResponse } from "~/services/claude/cli/translate"
import {
  decodeMessagesRequest,
  encodeMessagesRequest,
  decodeChatRequest,
  encodeChatRequest,
} from "~/services/ir/codecs/messages-chat/request"
import {
  drain,
  installFakeClaude,
  testConnection,
  testCredential,
} from "./claude-cli-fixtures"

let context: ClaudeCliRunContext
beforeEach(async () => {
  runRegistry.clear()
  const binary = await installFakeClaude()
  setClaudeCliTestHooks({ findBinary: () => binary })
  setClaudeCallbackBaseUrl("http://127.0.0.1:1")
  process.env.FAKE_CLAUDE_SCENARIO = "persistent"
  context = {
    connection: testConnection(),
    credential: testCredential(),
    model: "claude-sonnet-4-6",
    accessToken: "test-token",
  }
})
afterEach(() => {
  runRegistry.clear()
  setClaudeCliTestHooks({})
  resetClaudeCallbackBaseUrlForTest()
  delete process.env.FAKE_CLAUDE_SCENARIO
  delete process.env.FAKE_CLAUDE_REJECT_CONTROL
  delete process.env.FAKE_CLAUDE_IGNORE_CONTROL
})
function payload(): AnthropicMessagesPayload {
  return {
    model: context.model,
    max_tokens: 1024,
    system: "system instruction",
    messages: [{ role: "user", content: "first question" }],
  }
}
function nextPayload(
  first: AnthropicMessagesPayload,
  reply: AnthropicResponse,
): AnthropicMessagesPayload {
  return {
    ...first,
    messages: [
      ...first.messages,
      {
        role: "assistant",
        content: reply.content as Extract<
          AnthropicMessagesPayload["messages"][number],
          { role: "assistant" }
        >["content"],
      },
      { role: "user", content: "second question" },
    ],
  }
}
function detail(reply: AnthropicResponse): {
  pid: number
  turn: number
  input: unknown
  args: Array<string>
} {
  const block = reply.content.find((item) => item.type === "text")
  if (!block || block.type !== "text") throw new Error("no text")
  return JSON.parse(block.text)
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

describe("Claude CLI persistent sessions", () => {
  test("an old segment cannot release the next segment's consumer", async () => {
    const registration = spyOn(runRegistry, "register")
    try {
      const request = payload()
      const iterator = (await streamClaudeCliMessages(context, request))[
        Symbol.asyncIterator
      ]()
      const events: Array<AnthropicStreamEventData> = []
      for (;;) {
        const event = await iterator.next()
        if (event.done) throw new Error("missing message_stop")
        events.push(event.value)
        if (event.value.type === "message_stop") break
      }
      const reply = await collectAnthropicResponse(
        (async function* () {
          yield* events
        })(),
        context.model,
      )
      const next = await streamClaudeCliMessages(
        context,
        nextPayload(request, reply),
      )
      const run = registration.mock.calls[0]![0]
      try {
        expect(registration).toHaveBeenCalledTimes(1)
        await iterator.return?.()
        expect(run.availableForResume?.()).toBe(false)
      } finally {
        await drain(next)
      }
    } finally {
      registration.mockRestore()
    }
  }, 20_000)
  test("restarts with full history after an effort acknowledgment timeout", async () => {
    process.env.FAKE_CLAUDE_IGNORE_CONTROL = "1"
    const request = payload()
    const first = await collectClaudeCliMessages(context, request)
    const second = await collectClaudeCliMessages(context, {
      ...nextPayload(request, first),
      output_config: { effort: "high" },
    })
    expect(detail(second).pid).not.toBe(detail(first).pid)
    expect(JSON.stringify(detail(second).input)).toContain("first question")
  }, 15000)
  test("cancels a pending effort update and releases the process", async () => {
    process.env.FAKE_CLAUDE_IGNORE_CONTROL = "1"
    const request = payload()
    const first = await collectClaudeCliMessages(context, request)
    const signal = new AbortController()
    const pending = rejection(
      collectClaudeCliMessages(
        { ...context, signal: signal.signal },
        { ...nextPayload(request, first), output_config: { effort: "high" } },
      ),
    )
    setTimeout(() => signal.abort(new Error("cancel-effort")), 50)
    expect(await pending).toMatchObject({ message: "cancel-effort" })
    expect(runRegistry.countForConnection(context.connection.id)).toBe(0)
  }, 20_000)
  test("restarts with full history if the CLI rejects an effort update", async () => {
    process.env.FAKE_CLAUDE_REJECT_CONTROL = "1"
    const request = payload()
    const first = await collectClaudeCliMessages(context, request)
    const next = {
      ...nextPayload(request, first),
      output_config: { effort: "high" as const },
    }
    const second = await collectClaudeCliMessages(context, next)
    expect(detail(second).pid).not.toBe(detail(first).pid)
    expect(JSON.stringify(detail(second).input)).toContain("first question")
    expect(detail(second).args).toContain("high")
  }, 20_000)
  test("reuses the same process and sends only new user messages", async () => {
    const request = payload()
    const first = await collectClaudeCliMessages(context, request)
    const abort = new AbortController()
    const second = await collectClaudeCliMessages(
      { ...context, signal: abort.signal },
      nextPayload(request, first),
    )
    abort.abort()
    expect(detail(second).pid).toBe(detail(first).pid)
    expect(detail(second).turn).toBe(2)
    expect(JSON.stringify(detail(second).input)).toContain("second question")
    expect(JSON.stringify(detail(second).input)).not.toContain("first question")
    expect(JSON.stringify(detail(second).input)).not.toContain(
      "system instruction",
    )
    const third = await collectClaudeCliMessages(
      context,
      nextPayload(nextPayload(request, first), second),
    )
    expect(detail(third).turn).toBe(3)
  }, 20_000)
  test.each([
    "model",
    "system",
    "tools",
    "history",
    "credential",
    "token",
    "proxy",
    "image",
  ])(
    "starts a fresh process when %s changes",
    async (changed) => {
      const request = payload()
      const first = await collectClaudeCliMessages(context, request)
      const next = nextPayload(request, first)
      const nextContext = { ...context }
      switch (changed) {
        case "model":
          nextContext.model = next.model = "claude-opus-4-6"
          break
        case "system":
          next.system = "changed system"
          break
        case "tools":
          next.tools = [{ name: "new_tool", input_schema: { type: "object" } }]
          break
        case "history":
          next.messages[0] = { role: "user", content: "edited question" }
          break
        case "credential":
          nextContext.credential = testCredential({ id: "other-credential" })
          break
        case "token":
          nextContext.accessToken = "refreshed-token"
          break
        case "proxy":
          nextContext.connection = testConnection({
            proxyUrl: "http://127.0.0.1:9999",
          })
          break
        case "image":
          next.messages[0] = {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "changed",
                },
              },
            ],
          }
          break
      }
      const second = await collectClaudeCliMessages(nextContext, next)
      expect(detail(second).pid).not.toBe(detail(first).pid)
      expect(detail(second).turn).toBe(1)
    },
    20_000,
  )
  test("checks out an idle process only once for concurrent continuations", async () => {
    const request = payload()
    const first = await collectClaudeCliMessages(context, request)
    const replies = await Promise.all([
      collectClaudeCliMessages(context, nextPayload(request, first)),
      collectClaudeCliMessages(context, nextPayload(request, first)),
    ])
    expect(
      replies.filter((reply) => detail(reply).pid === detail(first).pid),
    ).toHaveLength(1)
    expect(new Set(replies.map((reply) => detail(reply).pid)).size).toBe(2)
  }, 20_000)
  test("updates effort inside the same process before sending the next turn", async () => {
    const request = payload()
    const first = await collectClaudeCliMessages(context, request)
    const next = {
      ...nextPayload(request, first),
      output_config: { effort: "xhigh" as const },
    }
    const second = await collectClaudeCliMessages(context, next)
    expect(detail(second).pid).toBe(detail(first).pid)
    expect(detail(second)).toMatchObject({ effort: "xhigh", turn: 2 })
    const third = await collectClaudeCliMessages(context, {
      ...nextPayload(next, second),
      output_config: undefined,
    })
    expect(detail(third)).toMatchObject({
      pid: detail(first).pid,
      effort: "",
      turn: 3,
    })
  }, 20_000)
  test("evicts idle sessions to leave room for new conversations", async () => {
    for (let i = 0; i < 5; i++)
      await collectClaudeCliMessages(context, {
        ...payload(),
        messages: [{ role: "user", content: `question ${i}` }],
      })
    expect(runRegistry.countForConnection(context.connection.id)).toBe(4)
  }, 20_000)
  test("does not treat tool results as a normal continuation", () => {
    expect(
      continuation({
        ...payload(),
        messages: [
          { role: "assistant", content: "answer" },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "id", content: "result" },
            ],
          },
        ],
      }),
    ).toBeUndefined()
  })
  test("normalizes text strings and preserves complete image bytes in session keys", () => {
    const request = payload()
    expect(sessionKey("owner", request)).toBe(
      sessionKey("owner", {
        ...request,
        messages: [
          { role: "user", content: [{ type: "text", text: "first question" }] },
        ],
      }),
    )
  })
})

describe("Claude CLI native capabilities", () => {
  test.each([true, false])(
    "enforces native search permissions through stdin (stream=%s)",
    async (stream) => {
      process.env.FAKE_CLAUDE_SCENARIO = "search-permission"
      const request = {
        ...payload(),
        stream,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 1,
            allowed_domains: ["caller.example"],
          },
        ],
      }
      const reply = await collectClaudeCliMessages(context, request)
      const text = reply.content.find((block) => block.type === "text")
      if (!text || text.type !== "text")
        throw new Error("missing permission diagnostics")
      const diagnostic = JSON.parse(text.text)
      expect(diagnostic.permissions).toEqual([
        {
          behavior: "allow",
          updatedInput: { query: "test", allowed_domains: ["caller.example"] },
        },
        {
          behavior: "deny",
          message: "The caller's web search max_uses has been reached",
        },
      ])
      expect(diagnostic.args).toContain("manual")
      expect(diagnostic.args).not.toContain("--dangerously-skip-permissions")
    },
    20_000,
  )
  test("enables only WebSearch and passes the JSON schema", () => {
    const args = claudeCliArgs({
      model: context.model,
      mcpConfigPath: "config.json",
      webSearch: true,
      jsonSchema: { type: "object" },
    })
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch")
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1])).toEqual({
      type: "object",
    })
    expect(args).toContain("--no-session-persistence")
  })
  test("merges native search rounds into one message without client tool calls", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "search"
    const events = await drain(
      await streamClaudeCliMessages(context, {
        ...payload(),
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    )
    expect(
      events.filter((event) => event.type === "message_start"),
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === "message_stop"),
    ).toHaveLength(1)
    const starts = events.filter(
      (event) => event.type === "content_block_start",
    )
    expect(starts.map((event) => event.index)).toEqual([0, 1, 2, 3])
    expect(starts.map((event) => event.content_block.type)).toEqual([
      "text",
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ])
    expect(starts[2].content_block).toMatchObject({
      tool_use_id: "internal",
      content: [
        {
          type: "web_search_result",
          url: "https://example.invalid/source",
          title: "Source",
        },
      ],
    })
    expect(
      events.findLast((event) => event.type === "message_delta"),
    ).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 20, output_tokens: 8 },
    })
  }, 20_000)
  test.each([false, true])(
    "returns only validated structured JSON (stream=%s)",
    async (stream) => {
      process.env.FAKE_CLAUDE_SCENARIO = "schema"
      const request = {
        ...payload(),
        stream,
        output_config: {
          format: { type: "json_schema" as const, schema: { type: "object" } },
        },
      }
      if (stream) {
        const events = await drain(
          await streamClaudeCliMessages(context, request),
        )
        expect(
          events.filter((event) => event.type === "content_block_delta"),
        ).toEqual([
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: '{"ok":true}' },
          },
        ])
      } else {
        expect(
          (await collectClaudeCliMessages(context, request)).content,
        ).toEqual([{ type: "text", text: '{"ok":true}' }])
      }
    },
    20_000,
  )
  test("propagates schema failure before returning a success response", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "schema-error"
    const error = await rejection(
      collectClaudeCliMessages(context, {
        ...payload(),
        output_config: {
          format: { type: "json_schema", schema: { type: "object" } },
        },
      }),
    )
    expect(error).toBeDefined()
    expect(String(error)).toContain("schema validation failed")
  }, 20_000)
  test("retains JSON schema through the Messages IR codec", () => {
    const request = {
      ...payload(),
      output_config: {
        effort: "high" as const,
        format: {
          type: "json_schema" as const,
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
      },
    }
    expect(
      encodeMessagesRequest(decodeMessagesRequest(request)).output_config
        ?.format,
    ).toEqual(request.output_config.format)
  })
  test("carries OpenAI JSON schema through Messages and back to Chat", () => {
    const request = {
      model: context.model,
      messages: [{ role: "user" as const, content: "answer in JSON" }],
      response_format: {
        type: "json_schema" as const,
        json_schema: {
          name: "answer",
          strict: true,
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      },
    }
    const ir = decodeChatRequest(request)
    expect(encodeMessagesRequest(ir).output_config?.format?.schema).toEqual(
      request.response_format.json_schema.schema,
    )
    expect(encodeChatRequest(ir).response_format).toEqual(
      request.response_format,
    )
  })
})
