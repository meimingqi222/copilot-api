import { describe, expect, test } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import { hasChatChunkOutput } from "~/routes/chat-completions/handler"
import { isMessagesOutputEvent } from "~/routes/messages/logging"
import {
  hasResponsesOutput,
  isResponsesOutputEvent,
} from "~/routes/responses/logging"

function chatChunk(
  delta: ChatCompletionChunk["choices"][number]["delta"],
): ChatCompletionChunk {
  return {
    id: "chatcmpl_timing",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
}

describe("protocol output timing classifiers", () => {
  test("Chat ignores role-only and empty tool frames", () => {
    expect(hasChatChunkOutput(chatChunk({ role: "assistant" }))).toBe(false)
    expect(hasChatChunkOutput(chatChunk({ content: "" }))).toBe(false)
    expect(hasChatChunkOutput(chatChunk({ tool_calls: [] }))).toBe(false)
  })

  test("Chat accepts visible and tool-call output", () => {
    expect(hasChatChunkOutput(chatChunk({ content: "x" }))).toBe(true)
    expect(
      hasChatChunkOutput(
        chatChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "" },
            },
          ],
        }),
      ),
    ).toBe(true)
  })

  test("Responses ignores empty structural events", () => {
    expect(
      isResponsesOutputEvent({
        type: "response.output_item.added",
        item: { type: "message", role: "assistant", content: [] },
      }),
    ).toBe(false)
    expect(
      isResponsesOutputEvent({
        type: "response.content_part.added",
        part: { type: "output_text", text: "" },
      }),
    ).toBe(false)
    expect(
      isResponsesOutputEvent({
        type: "response.output_text.delta",
        delta: "",
      }),
    ).toBe(false)
  })

  test("Responses accepts non-empty deltas and tool-call starts", () => {
    expect(
      isResponsesOutputEvent({
        type: "response.output_text.delta",
        delta: "x",
      }),
    ).toBe(true)
    expect(
      isResponsesOutputEvent({
        type: "response.output_item.added",
        item: { type: "function_call", name: "lookup", arguments: "" },
      }),
    ).toBe(true)
    expect(
      isResponsesOutputEvent({
        type: "response.output_text.done",
        text: "complete text",
      }),
    ).toBe(true)
  })

  test("Responses terminal output requires meaningful content", () => {
    expect(
      hasResponsesOutput({
        id: "resp_empty",
        model: "test-model",
        output: [{ type: "message", role: "assistant", content: [] }],
      }),
    ).toBe(false)
    expect(
      hasResponsesOutput({
        id: "resp_text",
        model: "test-model",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "x" }],
          },
        ],
      }),
    ).toBe(true)
  })

  test("Messages ignores empty block starts and signature-only deltas", () => {
    expect(
      isMessagesOutputEvent({
        type: "content_block_start",
        content_block: { type: "text", text: "" },
      }),
    ).toBe(false)
    expect(
      isMessagesOutputEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "" },
      }),
    ).toBe(false)
    expect(
      isMessagesOutputEvent({
        type: "content_block_delta",
        delta: { type: "signature_delta", signature: "sig" },
      }),
    ).toBe(false)
  })

  test("Messages accepts text and tool-use output", () => {
    expect(
      isMessagesOutputEvent({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "x" },
      }),
    ).toBe(true)
    expect(
      isMessagesOutputEvent({
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          id: "tool_1",
          name: "lookup",
          input: {},
        },
      }),
    ).toBe(true)
  })
})
