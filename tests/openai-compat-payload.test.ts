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
  fillCompatNullAssistantContent,
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
