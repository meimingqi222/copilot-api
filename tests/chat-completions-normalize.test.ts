import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  normalizeChunk,
  normalizeResponse,
} from "~/routes/chat-completions/normalize"

const chunk = (delta: Record<string, unknown>): ChatCompletionChunk =>
  ({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5",
    choices: [
      { index: 0, delta: { role: "assistant", ...delta }, finish_reason: null },
    ],
  }) as unknown as ChatCompletionChunk

const response = (message: Record<string, unknown>): ChatCompletionResponse =>
  ({
    id: "cmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gpt-5",
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: "stop",
        message: { role: "assistant", ...message },
      },
    ],
  }) as unknown as ChatCompletionResponse

describe("normalizeChunk", () => {
  test("fills reasoning_content from the reasoning_text alias", () => {
    const out = normalizeChunk(chunk({ reasoning_text: "thinking" }))
    expect(out.choices[0].delta.reasoning_content).toBe("thinking")
  })

  test("an empty reasoning_content does not shadow a populated alias", () => {
    // Upstreams routinely emit `reasoning_content: ""` under the spelling they
    // do not use. Treating that as "already present" (an `!== undefined`
    // check) handed the client an empty field while the real text sat one
    // alias away — and disagreed with extractReasoningTextAlias's `||` chain.
    const out = normalizeChunk(
      chunk({ reasoning_content: "", reasoning_text: "thinking" }),
    )
    expect(out.choices[0].delta.reasoning_content).toBe("thinking")
  })

  test("leaves a populated reasoning_content untouched", () => {
    const out = normalizeChunk(
      chunk({ reasoning_content: "mine", reasoning_text: "theirs" }),
    )
    expect(out.choices[0].delta.reasoning_content).toBe("mine")
  })

  test("adds nothing when no alias carries text", () => {
    const out = normalizeChunk(chunk({ content: "plain" }))
    expect(out.choices[0].delta.reasoning_content).toBeUndefined()
  })
})

describe("normalizeResponse", () => {
  test("an empty reasoning_content does not shadow a populated alias", () => {
    const out = normalizeResponse(
      response({ content: "done", reasoning_content: "", reasoning: "why" }),
    )
    expect(out.choices[0].message.reasoning_content).toBe("why")
  })

  test("leaves a populated reasoning_content untouched", () => {
    const out = normalizeResponse(
      response({ content: "done", reasoning_content: "mine", reasoning: "x" }),
    )
    expect(out.choices[0].message.reasoning_content).toBe("mine")
  })
})
