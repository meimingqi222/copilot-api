import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/responses-api-types"

import {
  translateChatCompletionToResponses,
  translateChatCompletionsStreamToResponses,
} from "~/services/copilot/chat-to-responses"
import { translateResponsesToChatPayload } from "~/services/copilot/responses-to-chat"

async function collectStreamEvents(
  stream: AsyncIterable<{ data?: string }>,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  for await (const frame of stream) {
    events.push(JSON.parse(frame.data ?? "{}") as Record<string, unknown>)
  }
  return events
}

function toStream(
  chunks: Array<ChatCompletionChunk>,
): AsyncIterable<{ data?: string }> {
  // Sync generator is sufficient (no upstream I/O); `for await` accepts it.
  return (function* () {
    for (const chunk of chunks) yield { data: JSON.stringify(chunk) }
  })() as unknown as AsyncIterable<{ data?: string }>
}

describe("chat → responses streaming reasoning", () => {
  test("picks up delta.reasoning_content (DeepSeek/Kimi/xAI style)", async () => {
    const chunk: ChatCompletionChunk = {
      id: "cmpl-1",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-5",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: "thinking step" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events = await collectStreamEvents(
      translateChatCompletionsStreamToResponses(toStream([chunk]), {
        model: "gpt-5",
        input: "hi",
      }),
    )

    const reasoningEvents = events.filter(
      (e) => e.type === "response.reasoning_summary_text.delta",
    )
    expect(reasoningEvents).toHaveLength(1)
    expect(reasoningEvents[0]).toMatchObject({ delta: "thinking step" })
  })

  test("emits no reasoning event when only content is present", async () => {
    const chunk: ChatCompletionChunk = {
      id: "cmpl-2",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-5",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "plain" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }

    const events = await collectStreamEvents(
      translateChatCompletionsStreamToResponses(toStream([chunk]), {
        model: "gpt-5",
        input: "hi",
      }),
    )

    expect(
      events.some((e) => e.type === "response.reasoning_summary_text.delta"),
    ).toBe(false)
  })
})

const chatResponse = (
  message: Record<string, unknown>,
): ChatCompletionResponse =>
  ({
    id: "cmpl-1",
    object: "chat.completion",
    created: 1,
    model: "deepseek-v4",
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: "tool_calls",
        message: { role: "assistant", ...message },
      },
    ],
  }) as ChatCompletionResponse

const requestPayload = { model: "deepseek-v4", input: [] } as ResponsesPayload

describe("chat → responses non-streaming reasoning", () => {
  test("picks up message.reasoning_content, not just reasoning_text", () => {
    const out = translateChatCompletionToResponses(
      chatResponse({ content: "done", reasoning_content: "think first" }),
      requestPayload,
    )
    const reasoning = out.output?.find((item) => item.type === "reasoning")
    expect(reasoning?.summary?.[0].text).toBe("think first")
  })

  test("picks up top-level message.thinking", () => {
    // The streaming twin (`getReasoningDelta`) accepts this spelling, and this
    // path does not run through routes/chat-completions/normalize.ts, so the
    // alias has to be handled here or it is dropped.
    const out = translateChatCompletionToResponses(
      chatResponse({ content: "done", thinking: "think first" }),
      requestPayload,
    )
    const reasoning = out.output?.find((item) => item.type === "reasoning")
    expect(reasoning?.summary?.[0].text).toBe("think first")
  })

  test("picks up a reasoning content part spelled with `thinking`", () => {
    const out = translateChatCompletionToResponses(
      chatResponse({
        content: [
          { type: "reasoning", thinking: "think first" },
          { type: "output_text", text: "done" },
        ],
      }),
      requestPayload,
    )
    const reasoning = out.output?.find((item) => item.type === "reasoning")
    expect(reasoning?.summary?.[0].text).toBe("think first")
  })

  test("emits the reasoning item before the message and function_call", () => {
    const out = translateChatCompletionToResponses(
      chatResponse({
        content: "doing it",
        reasoning_content: "think first",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "bash", arguments: "{}" },
          },
        ],
      }),
      requestPayload,
    )
    // Responses clients replay `output` in order; reasoning must precede the
    // item it explains.
    expect(out.output?.map((item) => item.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
    ])
  })
})

describe("responses → chat replayed reasoning items", () => {
  const input = [
    { role: "user", content: "list files" },
    {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "ENC",
      summary: [{ type: "summary_text", text: "I should ls" }],
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "bash",
      arguments: '{"cmd":"ls"}',
    },
    { type: "function_call_output", call_id: "call_1", output: "a.txt" },
  ] as ResponsesPayload["input"]

  test("never emits a tool message without tool_call_id", () => {
    const { messages } = translateResponsesToChatPayload({
      model: "m",
      input,
    })
    // Regression: the reasoning item used to fall through to the
    // function_call_output branch and become `{ role: "tool" }` with
    // undefined tool_call_id/content — malformed, and it broke the upstream
    // prefix on every replayed turn.
    for (const message of messages) {
      if (message.role !== "tool") continue
      expect(message.tool_call_id).toBeTruthy()
      expect(message.content).toBeTruthy()
    }
    expect(messages).toHaveLength(3)
    expect(messages[1].reasoning_content).toBeUndefined()
  })

  test("attaches the summary to the following assistant turn when opted in", () => {
    const { messages } = translateResponsesToChatPayload(
      { model: "m", input },
      { preserveHistoricalReasoning: true },
    )
    expect(messages).toHaveLength(3)
    expect(messages[1]).toMatchObject({
      role: "assistant",
      reasoning_content: "I should ls",
    })
  })
})
