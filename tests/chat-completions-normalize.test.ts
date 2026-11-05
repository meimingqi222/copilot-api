import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/protocols/chat/types"

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

  test("drops the source alias after mapping so thinking is not duplicated", () => {
    const out = normalizeChunk(chunk({ reasoning_text: "thinking" }))
    const delta = out.choices[0].delta as unknown as Record<string, unknown>
    expect("reasoning_text" in delta).toBe(false)
    expect("reasoning" in delta).toBe(false)
    expect("thinking" in delta).toBe(false)
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
    expect(out.choices[0].delta.reasoning_text).toBeUndefined()
  })

  test("adds nothing when no alias carries text", () => {
    const out = normalizeChunk(chunk({ content: "plain" }))
    expect(out.choices[0].delta.reasoning_content).toBeUndefined()
  })
})

describe("normalizeResponse", () => {
  test("separates interleaved reasoning from visible text without mutating internal block order", () => {
    const input = response({
      content: [
        { type: "reasoning", text: "First thought. ", signature: "sig-first" },
        { type: "text", text: "3" },
        { type: "thinking", thinking: "Last thought.", signature: "sig-last" },
        { type: "output_text", text: "23" },
      ],
      reasoning_text: "First thought. Last thought.",
    })
    const original = structuredClone(input)
    const message = normalizeResponse(input).choices[0].message
    expect(message.content).toBe("323")
    expect(message.reasoning_content).toBe("First thought. Last thought.")
    expect(message.reasoning_text).toBeUndefined()
    expect(message.reasoning_details).toEqual([
      {
        type: "reasoning.text",
        text: "First thought. ",
        signature: "sig-first",
      },
      { type: "reasoning.text", text: "Last thought.", signature: "sig-last" },
    ])
    expect(input).toEqual(original)
  })

  test("extracts content-only thinking while preserving media, tools and existing details", () => {
    const image = {
      type: "image_url" as const,
      image_url: { url: "https://example.com/image.png" },
    }
    const tools = [
      {
        id: "call-1",
        type: "function" as const,
        function: { name: "read", arguments: "{}" },
      },
    ]
    const details = [{ type: "reasoning.text", text: "why", signature: "sig" }]
    const message = normalizeResponse(
      response({
        content: [
          { type: "reasoning", text: "why", signature: "sig" },
          image,
          { type: "text", text: "answer" },
        ],
        tool_calls: tools,
        reasoning_details: details,
      }),
    ).choices[0].message
    expect(message.content).toEqual([image, { type: "text", text: "answer" }])
    expect(message.reasoning_content).toBe("why")
    expect(message.reasoning_details).toEqual(details)
    expect(message.tool_calls).toEqual(tools)
    const thinkingOnly = normalizeResponse(
      response({ content: [{ type: "thinking", thinking: "only thought" }] }),
    ).choices[0].message
    expect(thinkingOnly.content).toBeNull()
    expect(thinkingOnly.reasoning_content).toBe("only thought")
  })

  test("an empty reasoning_content does not shadow a populated alias", () => {
    const out = normalizeResponse(
      response({ content: "done", reasoning_content: "", reasoning: "why" }),
    )
    expect(out.choices[0].message.reasoning_content).toBe("why")
  })

  test("drops the source alias after mapping so thinking is not duplicated", () => {
    const out = normalizeResponse(
      response({ content: "done", reasoning_content: "", reasoning: "why" }),
    )
    const message = out.choices[0].message as unknown as Record<string, unknown>
    expect("reasoning" in message).toBe(false)
    expect("reasoning_text" in message).toBe(false)
    expect("thinking" in message).toBe(false)
  })

  test("leaves a populated reasoning_content untouched", () => {
    const out = normalizeResponse(
      response({ content: "done", reasoning_content: "mine", reasoning: "x" }),
    )
    expect(out.choices[0].message.reasoning_content).toBe("mine")
    expect(out.choices[0].message.reasoning).toBeUndefined()
    const canonicalOnly = normalizeResponse(
      response({
        content: [
          { type: "reasoning", text: "other spelling" },
          { type: "text", text: "done" },
        ],
        reasoning_content: "mine",
      }),
    )
    expect(canonicalOnly.choices[0].message.content).toBe("done")
    expect(canonicalOnly.choices[0].message.reasoning_content).toBe("mine")
  })
})
