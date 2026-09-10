import { describe, test, expect } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  createInitialStreamState,
  translateChunkToAnthropicEvents,
} from "~/services/protocols/anthropic"

/**
 * CodeBuddy 上游每个 chunk 都携带空数组字段：
 *   delta: { content: "", reasoning_content: "x", tool_calls: [], ... }
 * `tool_calls: []` 是 truthy，会把每个 reasoning token 冲成一个独立 thinking 块。
 */
function codebuddyStyleChunk(reasoning: string, content?: string) {
  // 上游实际发的 finish_reason 是 ""（不在类型联合里），按现有测试惯例断言
  return {
    id: "cmb-test",
    model: "deepseek-v4.1-flash",
    object: "chat.completion.chunk" as const,
    created: 1789018553,
    choices: [
      {
        index: 0,
        delta: {
          content: content ?? "",
          reasoning_content: reasoning,
          function_call: null,
          refusal: "",
          tool_calls: [],
          extra_fields: null,
        },
        logprobs: null,
        finish_reason: "",
      },
    ],
    usage: null,
  } as unknown as ChatCompletionChunk
}

describe("codebuddy empty tool_calls array", () => {
  test("consecutive reasoning chunks should reuse ONE thinking block", () => {
    const state = createInitialStreamState()
    const chunks = [
      codebuddyStyleChunk("9"),
      codebuddyStyleChunk("."),
      codebuddyStyleChunk("11"),
      codebuddyStyleChunk("小"),
      codebuddyStyleChunk("于"),
      codebuddyStyleChunk("9"),
      codebuddyStyleChunk("."),
      codebuddyStyleChunk("8"),
      // 结尾的 content chunk 触发缓冲的 thinking 落盘
      codebuddyStyleChunk("", "9.8更大"),
    ]

    const events = []
    for (const chunk of chunks) {
      events.push(...translateChunkToAnthropicEvents(chunk, state))
    }

    const starts = events.filter((e) => e.type === "content_block_start")
    const types = starts.map((e) => e.content_block.type)

    // 8 个 reasoning chunk + 1 个 content chunk：只应 1 个 thinking 块 + 1 个 text 块
    expect(types).toEqual(["thinking", "text"])
  })

  test("reasoning then content should produce exactly 2 blocks", () => {
    const state = createInitialStreamState()
    const chunks = [
      codebuddyStyleChunk("推理A"),
      codebuddyStyleChunk("推理B"),
      codebuddyStyleChunk("", "答案"),
      codebuddyStyleChunk("", "是9.8"),
    ]

    const events = []
    for (const chunk of chunks) {
      events.push(...translateChunkToAnthropicEvents(chunk, state))
    }

    const starts = events.filter((e) => e.type === "content_block_start")
    const types = starts.map((e) => e.content_block.type)

    expect(types).toEqual(["thinking", "text"])
  })
})
