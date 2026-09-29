/**
 * 通用 OpenAI 兼容请求体归一化的单元测试。
 *
 * 这些改写由 CodeBuddy 与 LobsterAI 两个 adapter 共用；触发它们的实测矩阵
 * （哪个上游对哪个形状回 5xx / 静默忽略）记录在
 * `src/services/protocols/openai-compat-payload.ts` 的文件头。
 */
import { describe, expect, test } from "bun:test"

import type { Message } from "~/services/copilot/create-chat-completions"

import {
  applyStrictBackendNormalization,
  clampStrictCompatChoiceCount,
  degradeStrictCompatToolChoice,
  dropStrictCompatResponseFormat,
  dropTrailingAssistantForStrictTools,
  fillCompatNullAssistantContent,
  flattenStrictToolHistory,
  normalizeCompatImageUrls,
  normalizeCompatRoles,
  normalizeCompatToolChoice,
  normalizeOpenAICompatChatPayload,
  pruneCompatOrphanToolCalls,
  repackCompatToolResults,
  translateCompatMaxCompletionTokens,
} from "~/services/protocols/openai-compat-payload"

const msg = (value: Record<string, unknown>) => value as unknown as Message

const toolCall = (id: string, name = "get_time") => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
})

describe("normalizeCompatRoles", () => {
  test("rewrites developer to system and leaves other roles alone", () => {
    const messages = [
      msg({ role: "developer", content: "a" }),
      msg({ role: "user", content: "b" }),
      msg({ role: "assistant", content: "c" }),
      msg({ role: "tool", tool_call_id: "t", content: "d" }),
      msg({ role: "system", content: "e" }),
    ]
    normalizeCompatRoles(messages)
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "system",
    ])
  })
})

describe("normalizeCompatToolChoice", () => {
  test("maps a function object to the bare function name", () => {
    const payload: Record<string, unknown> = {
      tool_choice: { type: "function", function: { name: " inspect " } },
    }
    normalizeCompatToolChoice(payload)
    expect(payload.tool_choice).toBe("inspect")
  })

  test("accepts the legacy top-level name spelling", () => {
    const payload: Record<string, unknown> = {
      tool_choice: { type: "function", name: "legacy" },
    }
    normalizeCompatToolChoice(payload)
    expect(payload.tool_choice).toBe("legacy")
  })

  test("falls back to auto when a function object carries no usable name", () => {
    const payload: Record<string, unknown> = {
      tool_choice: { type: "function", function: { name: "   " } },
    }
    normalizeCompatToolChoice(payload)
    expect(payload.tool_choice).toBe("auto")
  })

  test("collapses auto and required objects to their string form", () => {
    for (const type of ["auto", "required"]) {
      const payload: Record<string, unknown> = { tool_choice: { type } }
      normalizeCompatToolChoice(payload)
      expect(payload.tool_choice).toBe(type)
    }
  })

  test("drops tool_choice and suppresses tools for none", () => {
    for (const toolChoice of [
      "none",
      " NONE ",
      { type: "none" },
    ] as Array<unknown>) {
      const payload: Record<string, unknown> = {
        tool_choice: toolChoice,
        tools: [{ type: "function", function: { name: "x", parameters: {} } }],
        functions: [{ name: "x", parameters: {} }],
      }
      normalizeCompatToolChoice(payload)
      expect(payload.tool_choice).toBeUndefined()
      expect(payload.tools).toBeUndefined()
      expect(payload.functions).toBeUndefined()
    }
  })

  test("keeps a plain string choice and unknown objects drop the field", () => {
    const kept: Record<string, unknown> = { tool_choice: "auto" }
    normalizeCompatToolChoice(kept)
    expect(kept.tool_choice).toBe("auto")

    const unknown: Record<string, unknown> = {
      tool_choice: { type: "whatever" },
      tools: [],
    }
    normalizeCompatToolChoice(unknown)
    expect(unknown.tool_choice).toBeUndefined()
    // 未知类型只删 tool_choice，不动 tools（与 none 不同）。
    expect(unknown.tools).toEqual([])
  })

  test("is a no-op when tool_choice is absent", () => {
    const payload: Record<string, unknown> = { tools: [] }
    normalizeCompatToolChoice(payload)
    expect(payload).toEqual({ tools: [] })
  })
})

describe("translateCompatMaxCompletionTokens", () => {
  test("translates the alias when max_tokens is absent", () => {
    const payload: Record<string, unknown> = { max_completion_tokens: 4096 }
    translateCompatMaxCompletionTokens(payload)
    expect(payload.max_completion_tokens).toBeUndefined()
    expect(payload.max_tokens).toBe(4096)
  })

  test("explicit max_tokens wins and the alias is only deleted", () => {
    const payload: Record<string, unknown> = {
      max_completion_tokens: 4096,
      max_tokens: 128,
    }
    translateCompatMaxCompletionTokens(payload)
    expect(payload.max_completion_tokens).toBeUndefined()
    expect(payload.max_tokens).toBe(128)
  })

  test("does not translate non-positive or non-integer values", () => {
    for (const value of [0, -1, 1.5, "4096", null, undefined]) {
      const payload: Record<string, unknown> = { max_completion_tokens: value }
      translateCompatMaxCompletionTokens(payload)
      expect(payload.max_completion_tokens).toBeUndefined()
      expect(payload.max_tokens).toBeUndefined()
    }
  })
})

describe("normalizeCompatImageUrls", () => {
  test("wraps a bare string url and leaves object form untouched", () => {
    const messages = [
      msg({
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: "data:image/png;base64,xx" },
        ],
      }),
      msg({
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }],
      }),
      msg({ role: "user", content: "plain string content" }),
    ]
    normalizeCompatImageUrls(messages)
    const first = messages[0].content as unknown as Array<
      Record<string, unknown>
    >
    expect(first[1]?.image_url).toEqual({ url: "data:image/png;base64,xx" })
    const second = messages[1].content as unknown as Array<
      Record<string, unknown>
    >
    expect(second[0]?.image_url).toEqual({ url: "https://x/y.png" })
    expect(messages[2].content).toBe("plain string content")
  })

  test("ignores an empty string url instead of inventing a value", () => {
    const messages = [
      msg({
        role: "user",
        content: [{ type: "image_url", image_url: "" }],
      }),
    ]
    normalizeCompatImageUrls(messages)
    const parts = messages[0].content as unknown as Array<
      Record<string, unknown>
    >
    expect(parts[0]?.image_url).toBe("")
  })
})

describe("fillCompatNullAssistantContent", () => {
  test("fills null content only when the assistant message has no tool_calls", () => {
    const messages = [
      msg({ role: "assistant", content: null }),
      msg({ role: "assistant", content: null, tool_calls: [toolCall("c1")] }),
      msg({ role: "assistant", content: "" }),
      msg({ role: "user", content: null }),
    ]
    fillCompatNullAssistantContent(messages)
    expect(messages[0].content).toBe("")
    // 带 tool_calls 的 null 是合法形态，保持原样。
    expect(messages[1].content).toBeNull()
    expect(messages[2].content).toBe("")
    // 非 assistant 角色不参与（上游对 user/system 的 null 语义不同）。
    expect(messages[3].content).toBeNull()
  })

  test("treats an empty tool_calls array as 'no tool calls'", () => {
    const messages = [msg({ role: "assistant", content: null, tool_calls: [] })]
    fillCompatNullAssistantContent(messages)
    expect(messages[0].content).toBe("")
  })
})

describe("repackCompatToolResults", () => {
  test("moves messages interleaved inside a tool group behind the results", () => {
    const messages = [
      msg({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("c00"), toolCall("c01")],
      }),
      msg({ role: "tool", tool_call_id: "c00", content: "r0" }),
      msg({ role: "system", content: "image_resize_notice" }),
      msg({ role: "tool", tool_call_id: "c01", content: "r1" }),
    ]
    const out = repackCompatToolResults(messages)
    expect(out.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "system",
    ])
    expect(out[1]?.tool_call_id).toBe("c00")
    expect(out[2]?.tool_call_id).toBe("c01")
  })

  test("returns the same array when nothing needs moving", () => {
    const messages = [
      msg({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("c00")],
      }),
      msg({ role: "tool", tool_call_id: "c00", content: "r0" }),
      msg({ role: "user", content: "next" }),
    ]
    expect(repackCompatToolResults(messages)).toBe(messages)
  })

  test("does not swallow the next assistant tool_calls group", () => {
    const messages = [
      msg({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("c00")],
      }),
      msg({ role: "tool", tool_call_id: "c00", content: "r0" }),
      msg({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("c10")],
      }),
      msg({ role: "tool", tool_call_id: "c10", content: "r1" }),
    ]
    expect(repackCompatToolResults(messages)).toBe(messages)
  })

  test("stops at a tool result that belongs to a different group", () => {
    const messages = [
      msg({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("c00")],
      }),
      msg({ role: "tool", tool_call_id: "c00", content: "r0" }),
      msg({ role: "tool", tool_call_id: "other", content: "rx" }),
    ]
    expect(repackCompatToolResults(messages)).toBe(messages)
  })
})

describe("pruneCompatOrphanToolCalls", () => {
  test("prunes both directions symmetrically", () => {
    const messages = [
      msg({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("c00"), toolCall("c01")],
      }),
      msg({ role: "tool", tool_call_id: "c00", content: "r0" }),
      msg({ role: "tool", tool_call_id: "orphan", content: "rx" }),
    ]
    const out = pruneCompatOrphanToolCalls(messages)
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"])
    expect(out[0]?.tool_calls?.map((tc) => tc.id)).toEqual(["c00"])
    expect(out[1]?.tool_call_id).toBe("c00")
  })

  test("removes tool_calls entirely when every call is unmatched", () => {
    const messages = [
      msg({
        role: "assistant",
        content: "no tools ran",
        tool_calls: [toolCall("c00")],
      }),
    ]
    const out = pruneCompatOrphanToolCalls(messages)
    expect(out[0]?.tool_calls).toBeUndefined()
    expect(out[0]?.content).toBe("no tools ran")
  })

  test("drops tool messages whose id does not match the assistant call", () => {
    const messages = [
      msg({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("c00")],
      }),
      msg({ role: "tool", tool_call_id: "c99", content: "rx" }),
    ]
    const out = pruneCompatOrphanToolCalls(messages)
    expect(out.map((m) => m.role)).toEqual(["assistant"])
  })

  test("returns the same array when nothing is orphaned", () => {
    const messages = [
      msg({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("c00")],
      }),
      msg({ role: "tool", tool_call_id: "c00", content: "r0" }),
    ]
    expect(pruneCompatOrphanToolCalls(messages)).toBe(messages)
  })

  test("ignores tool messages without an id and calls without an id", () => {
    const messages = [
      msg({ role: "tool", content: "no id" }),
      msg({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("")],
      }),
    ]
    expect(pruneCompatOrphanToolCalls(messages)).toBe(messages)
  })
})

describe("normalizeOpenAICompatChatPayload", () => {
  test("clones the payload and applies every rewrite", () => {
    const payload = {
      model: "deepseek-flash",
      stream: false,
      max_completion_tokens: 4096,
      tool_choice: { type: "function", function: { name: "get_time" } },
      messages: [
        msg({ role: "developer", content: "be helpful" }),
        msg({ role: "assistant", content: null }),
        msg({
          role: "user",
          content: [
            { type: "image_url", image_url: "data:image/png;base64,xx" },
          ],
        }),
        msg({
          role: "assistant",
          content: null,
          tool_calls: [toolCall("c00"), toolCall("c01")],
        }),
        msg({ role: "tool", tool_call_id: "c00", content: "r0" }),
        msg({ role: "system", content: "image_resize_notice" }),
        msg({ role: "tool", tool_call_id: "c01", content: "r1" }),
        msg({ role: "tool", tool_call_id: "orphan", content: "rx" }),
      ],
      tools: [
        { type: "function", function: { name: "get_time", parameters: {} } },
      ],
    }
    const original = structuredClone(payload)

    const out = normalizeOpenAICompatChatPayload(
      payload as unknown as Parameters<
        typeof normalizeOpenAICompatChatPayload
      >[0],
    )

    // 调用方的 payload 必须原样保留（failover 会重放它）。
    expect(payload).toEqual(original)
    // 返回值是独立副本。
    expect(out.messages).not.toBe(payload.messages as unknown as unknown[])
    expect(out.tools).not.toBe(payload.tools)

    expect(out.messages.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "user",
      "assistant",
      "tool",
      "tool",
      "system",
    ])
    expect(out.messages[0]?.content).toBe("be helpful")
    expect(out.messages[1]?.content).toBe("")
    const parts = out.messages[2]?.content as unknown as Array<
      Record<string, unknown>
    >
    expect(parts[0]?.image_url).toEqual({ url: "data:image/png;base64,xx" })
    expect(out.messages[3]?.tool_calls?.map((tc) => tc.id)).toEqual([
      "c00",
      "c01",
    ])
    const raw = out as unknown as Record<string, unknown>
    expect(raw.max_completion_tokens).toBeUndefined()
    expect(raw.max_tokens).toBe(4096)
    expect(raw.tool_choice).toBe("get_time")
    // 未提供 tools 时不凭空造出该字段。
    expect(raw.stream).toBe(false)
  })

  test("backfills null assistant content after orphan pruning", () => {
    // 工具执行失败/中断后，客户端把"无结果"的 tool_calls 持久化进历史并每次
    // 重放：裁剪掉这些调用后，assistant 会停在 `content: null` 且没有
    // tool_calls —— 严格后端（LobsterAI 的 deepseek 系）对它回 500。
    const payload = {
      model: "deepseek-flash",
      messages: [
        msg({ role: "user", content: "go" }),
        msg({
          role: "assistant",
          content: null,
          tool_calls: [toolCall("c1")],
        }),
        msg({ role: "tool", tool_call_id: "orphan", content: "rx" }),
      ],
    }
    const out = normalizeOpenAICompatChatPayload(
      payload as unknown as Parameters<
        typeof normalizeOpenAICompatChatPayload
      >[0],
    )
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect((out.messages[1] as { content: unknown }).content).toBe("")
  })

  test("leaves an already-clean payload structurally identical", () => {
    const payload = {
      model: "glm-5.2",
      messages: [
        msg({ role: "system", content: "s" }),
        msg({ role: "user", content: "u" }),
      ],
    }
    const out = normalizeOpenAICompatChatPayload(
      payload as unknown as Parameters<
        typeof normalizeOpenAICompatChatPayload
      >[0],
    )
    expect(out.messages).toEqual(payload.messages)
    expect("tools" in out).toBe(false)
  })
})

describe("flattenStrictToolHistory", () => {
  test("turns assistant tool_calls and tool results into text", () => {
    const messages = [
      msg({ role: "user", content: "read config.yaml" }),
      msg({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("call_00_FOREIGNxyz", "read")],
      }),
      msg({
        role: "tool",
        tool_call_id: "call_00_FOREIGNxyz",
        name: "read",
        content: "port: 4141",
      }),
    ]
    expect(flattenStrictToolHistory(messages)).toBe(2)
    // 不再回放任何 tool_call id（严格后端只认自己签发的 id）。
    expect(messages[1].tool_calls).toBeUndefined()
    expect(String(messages[1].content)).toContain("call_00_FOREIGNxyz")
    expect(String(messages[1].content)).toContain("read(")
    expect(messages[1].role).toBe("assistant")
    // tool 结果降级为 user 文本，id 字段一并清掉。
    expect(messages[2].role).toBe("user")
    expect(messages[2].tool_call_id).toBeUndefined()
    expect(String(messages[2].content)).toBe("[tool_result read] port: 4141")
  })

  test("keeps existing assistant text and image parts", () => {
    const image = {
      type: "image_url" as const,
      image_url: { url: "data:image/png;base64,AA" },
    }
    const textPart = (text: string) => ({ type: "text" as const, text })
    const withText = msg({
      role: "assistant",
      content: "here you go",
      tool_calls: [toolCall("c1", "read")],
    })
    const withParts = msg({
      role: "assistant",
      content: [image],
      tool_calls: [toolCall("c2", "read")],
    })
    const toolWithParts = msg({
      role: "tool",
      tool_call_id: "c2",
      content: [image],
    })
    expect(flattenStrictToolHistory([withText, withParts, toolWithParts])).toBe(
      3,
    )
    expect(String(withText.content)).toBe(
      "here you go\n[tool_call id=c1] read({})",
    )
    expect(withParts.content).toEqual([
      image,
      textPart("[tool_call id=c2] read({})"),
    ])
    expect(toolWithParts.content).toEqual([textPart("[tool_result c2]"), image])
    expect(toolWithParts.role).toBe("user")
  })

  test("is a no-op when there is no tool history", () => {
    const messages = [
      msg({ role: "system", content: "s" }),
      msg({ role: "user", content: "u" }),
    ]
    expect(flattenStrictToolHistory(messages)).toBe(0)
    expect(messages[1].content).toBe("u")
  })
})

describe("strict backend parameter degradations", () => {
  test("degrades named and required tool_choice to auto", () => {
    for (const toolChoice of [
      "get_time",
      "required",
      { type: "function", function: { name: "get_time" } },
    ]) {
      const payload: Record<string, unknown> = { tool_choice: toolChoice }
      expect(degradeStrictCompatToolChoice(payload)).toBe(true)
      expect(payload.tool_choice).toBe("auto")
    }
    const auto: Record<string, unknown> = { tool_choice: "auto" }
    expect(degradeStrictCompatToolChoice(auto)).toBe(false)
    expect(auto.tool_choice).toBe("auto")
    const absent: Record<string, unknown> = {}
    expect(degradeStrictCompatToolChoice(absent)).toBe(false)
  })

  test("drops only json response_format", () => {
    const json: Record<string, unknown> = {
      response_format: { type: "json_object" },
    }
    expect(dropStrictCompatResponseFormat(json)).toBe(true)
    expect("response_format" in json).toBe(false)

    const schema: Record<string, unknown> = {
      response_format: { type: "json_schema", json_schema: { name: "x" } },
    }
    expect(dropStrictCompatResponseFormat(schema)).toBe(true)

    const text: Record<string, unknown> = { response_format: { type: "text" } }
    expect(dropStrictCompatResponseFormat(text)).toBe(false)
    expect(text.response_format).toEqual({ type: "text" })
  })

  test("clamps n>1 to the upstream default", () => {
    const n2: Record<string, unknown> = { n: 2 }
    expect(clampStrictCompatChoiceCount(n2)).toBe(true)
    expect("n" in n2).toBe(false)
    const n1: Record<string, unknown> = { n: 1 }
    expect(clampStrictCompatChoiceCount(n1)).toBe(false)
    expect(n1.n).toBe(1)
  })

  test("applyStrictBackendNormalization reports every rewrite at once", () => {
    const payload = {
      model: "deepseek-flash",
      stream: true,
      n: 2,
      response_format: { type: "json_object" },
      tool_choice: { type: "function", function: { name: "get_time" } },
      messages: [
        msg({ role: "user", content: "u" }),
        msg({ role: "assistant", content: null, tool_calls: [toolCall("c1")] }),
        msg({ role: "tool", tool_call_id: "c1", content: "r" }),
      ],
    } as unknown as Parameters<typeof applyStrictBackendNormalization>[0]
    const report = applyStrictBackendNormalization(payload)
    expect(report).toEqual({
      flattenedToolMessages: 2,
      trailingAssistantDropped: 0,
      toolChoiceDegraded: true,
      responseFormatDropped: true,
      choiceCountClamped: true,
    })
    const raw = payload as unknown as Record<string, unknown>
    expect(raw.tool_choice).toBe("auto")
    expect("response_format" in raw).toBe(false)
    expect("n" in raw).toBe(false)
    expect(raw.messages).toEqual([
      { role: "user", content: "u" },
      { role: "assistant", content: "[tool_call id=c1] get_time({})" },
      { role: "user", content: "[tool_result c1] r" },
    ])
  })
})

describe("dropTrailingAssistantForStrictTools", () => {
  const tools = [
    {
      type: "function",
      function: { name: "read", parameters: { type: "object" } },
    },
  ]
  const run = (messages: Array<Record<string, unknown>>, withTools = true) => {
    const payload: Record<string, unknown> = { messages }
    if (withTools) payload.tools = tools
    const dropped = dropTrailingAssistantForStrictTools(payload)
    return { dropped, roles: messages.map((m) => m.role) }
  }

  test("drops a trailing assistant when tools are declared", () => {
    expect(
      run([
        { role: "user", content: "u" },
        { role: "assistant", content: "" },
      ]),
    ).toEqual({ dropped: 1, roles: ["user"] })
    expect(
      run([
        { role: "user", content: "u" },
        { role: "assistant", content: "ok" },
      ]),
    ).toEqual({ dropped: 1, roles: ["user"] })
  })

  test("skips trailing system messages when judging the tail", () => {
    expect(
      run([
        { role: "user", content: "u" },
        { role: "assistant", content: "ok" },
        { role: "system", content: "s" },
      ]),
    ).toEqual({ dropped: 1, roles: ["user", "system"] })
    // 末尾是 user：不动。
    expect(
      run([
        { role: "user", content: "u" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "more" },
      ]),
    ).toEqual({ dropped: 0, roles: ["user", "assistant", "user"] })
  })

  test("is a no-op without a non-empty tools array", () => {
    const messages = [
      { role: "user", content: "u" },
      { role: "assistant", content: "ok" },
    ]
    expect(run(structuredClone(messages), false).dropped).toBe(0)
    const emptyTools: Record<string, unknown> = { messages, tools: [] }
    expect(dropTrailingAssistantForStrictTools(emptyTools)).toBe(0)
  })

  test("never empties the message list", () => {
    expect(run([{ role: "assistant", content: "ok" }])).toEqual({
      dropped: 0,
      roles: ["assistant"],
    })
  })
})
