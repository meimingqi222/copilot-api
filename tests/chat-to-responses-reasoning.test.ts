import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/responses-api-types"

import {
  translateChatCompletionToResponses,
  translateChatCompletionsStreamToResponses,
  translateToResponsesPayload,
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

  test("picks up delta.reasoning_details when no top-level alias is set", async () => {
    // OpenRouter-style upstreams put the reasoning only here. The sibling
    // anthropic/stream-translation.ts reads this field, so this path dropped
    // the whole chain of thought for those upstreams while its twin kept it.
    const chunk: ChatCompletionChunk = {
      id: "cmpl-3",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-5",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_details: [
              { type: "reasoning.text", text: "step " },
              { type: "reasoning.text", text: "one" },
            ],
          },
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
    expect(reasoningEvents[0]).toMatchObject({ delta: "step one" })
  })

  test("an empty top-level alias does not shadow delta.reasoning_details", async () => {
    const chunk: ChatCompletionChunk = {
      id: "cmpl-4",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-5",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: "",
            reasoning_details: [{ type: "reasoning.text", text: "step one" }],
          },
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

    expect(
      events.filter((e) => e.type === "response.reasoning_summary_text.delta"),
    ).toMatchObject([{ delta: "step one" }])
  })

  test("does not duplicate reasoning echoed under both an alias and details", async () => {
    const chunk: ChatCompletionChunk = {
      id: "cmpl-5",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-5",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning: "step one",
            reasoning_details: [{ type: "reasoning.text", text: "step one" }],
          },
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

    expect(
      events.filter((e) => e.type === "response.reasoning_summary_text.delta"),
    ).toMatchObject([{ delta: "step one" }])
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

  test("an empty top-level alias does not shadow reasoning content parts", () => {
    // `reasoning_content: ""` is what upstreams emit on turns without thinking,
    // so it shows up on replayed history next to real part-carried reasoning.
    const out = translateChatCompletionToResponses(
      chatResponse({
        reasoning_content: "",
        content: [
          { type: "reasoning", text: "think first" },
          { type: "output_text", text: "done" },
        ],
      }),
      requestPayload,
    )
    const reasoning = out.output?.find((item) => item.type === "reasoning")
    expect(reasoning?.summary?.[0].text).toBe("think first")
  })

  test("picks up message.reasoning_details when no top-level alias is set", () => {
    // Mirrors the streaming twin: an OpenRouter-style upstream carries the
    // reasoning only here, and reading just the aliases dropped it.
    const out = translateChatCompletionToResponses(
      chatResponse({
        content: "done",
        reasoning_details: [
          { type: "reasoning.text", text: "think " },
          { type: "reasoning.text", text: "first" },
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

// `choices` is typed as required on both the chunk and the response, but
// upstreams omit it on usage-only / filter chunks and can return an empty list
// outright. Every reader on this path has to survive that.
describe("chat → responses tolerates upstream chunks without choices", () => {
  test("a usage-only chunk with no choices does not crash the stream", async () => {
    const usageOnly = {
      id: "cmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4",
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    } as unknown as ChatCompletionChunk

    const events = await collectStreamEvents(
      translateChatCompletionsStreamToResponses(toStream([usageOnly]), {
        model: "deepseek-v4",
        input: [],
      } as ResponsesPayload),
    )
    expect(events.length).toBeGreaterThan(0)
  })

  test("an empty choices array reports the upstream id, not a TypeError", () => {
    const empty = {
      id: "cmpl-empty",
      object: "chat.completion",
      created: 1,
      model: "deepseek-v4",
      choices: [],
    } as unknown as ChatCompletionResponse

    expect(() =>
      translateChatCompletionToResponses(empty, requestPayload),
    ).toThrow(/cmpl-empty/)
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

  test("does not carry a summary past an intervening tool result", () => {
    // A reasoning item whose assistant turn never materialized used to stay
    // pending and attach itself to whatever assistant turn came next — one
    // turn's chain of thought reported as another's.
    const orphaned = [
      { role: "user", content: "list files" },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "orphaned thought" }],
      },
      { type: "function_call_output", call_id: "call_1", output: "a.txt" },
      { role: "assistant", content: "here they are" },
    ] as ResponsesPayload["input"]

    const { messages } = translateResponsesToChatPayload(
      { model: "m", input: orphaned },
      { preserveHistoricalReasoning: true },
    )

    const assistant = messages.find((message) => message.role === "assistant")
    expect(assistant?.reasoning_content).toBeUndefined()
  })

  test("does not carry a summary past an intervening user turn", () => {
    const orphaned = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "orphaned thought" }],
      },
      { role: "user", content: "actually, never mind" },
      { role: "assistant", content: "ok" },
    ] as ResponsesPayload["input"]

    const { messages } = translateResponsesToChatPayload(
      { model: "m", input: orphaned },
      { preserveHistoricalReasoning: true },
    )

    const assistant = messages.find((message) => message.role === "assistant")
    expect(assistant?.reasoning_content).toBeUndefined()
  })
})

describe("chat → responses input translation (historical reasoning)", () => {
  test("injects historical reasoning exactly once when top-level and content parts agree", () => {
    // The proxy's own responses→chat output carries reasoning both as
    // top-level reasoning_content and as content parts; replaying it must not
    // double the reasoning in the upstream prompt.
    const out = translateToResponsesPayload({
      model: "gpt-5",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "reasoning", text: "step one" },
          ],
          reasoning_content: "step one",
        },
      ],
    } satisfies ChatCompletionsPayload)

    const input = Array.isArray(out.input) ? out.input : []
    const assistant = input.find(
      (item) => "role" in item && item.role === "assistant",
    )
    const texts =
      assistant && "role" in assistant && Array.isArray(assistant.content) ?
        assistant.content.map((part) => ("text" in part ? part.text : ""))
      : []
    expect(texts).toEqual(["[historical reasoning] step one", "answer"])
    // The content-part copy is stripped — reasoning appears in the input
    // exactly once instead of twice.
    expect(JSON.stringify(input).match(/step one/g)).toHaveLength(1)
  })

  test("injects historical reasoning once for assistant turns with tool calls", () => {
    const out = translateToResponsesPayload({
      model: "gpt-5",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "answer" },
            { type: "thinking", text: "step one" },
          ],
          reasoning_content: "step one",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "bash", arguments: "{}" },
            },
          ],
        },
      ],
    } satisfies ChatCompletionsPayload)

    const input = Array.isArray(out.input) ? out.input : []
    const assistant = input.find(
      (item) => "role" in item && item.role === "assistant",
    )
    const texts =
      assistant && "role" in assistant && Array.isArray(assistant.content) ?
        assistant.content.map((part) => ("text" in part ? part.text : ""))
      : []
    expect(texts).toEqual(["[historical reasoning] step one", "answer"])
    expect(
      input.filter((item) => "type" in item && item.type === "function_call"),
    ).toHaveLength(1)
    expect(JSON.stringify(input).match(/step one/g)).toHaveLength(1)
  })
})
