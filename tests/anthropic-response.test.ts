import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  createInitialStreamState,
  type AnthropicStreamEventData,
} from "~/routes/messages/anthropic-types"
import { translateToAnthropic } from "~/routes/messages/non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateStreamEndEvents,
} from "~/routes/messages/stream-translation"

function translateFullStream(
  openAIStream: Array<ChatCompletionChunk>,
  estimatedInputTokens = 0,
): Array<AnthropicStreamEventData> {
  const streamState = createInitialStreamState()
  streamState.estimatedInputTokens = estimatedInputTokens
  const events = openAIStream.flatMap((chunk) =>
    translateChunkToAnthropicEvents(chunk, streamState),
  )
  return [...events, ...translateStreamEndEvents(streamState)]
}

const anthropicUsageSchema = z.object({
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
})

const anthropicContentBlockTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
})

const anthropicContentBlockThinkingSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
})

const anthropicContentBlockToolUseSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.any()),
})

const anthropicMessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.union([
      anthropicContentBlockTextSchema,
      anthropicContentBlockThinkingSchema,
      anthropicContentBlockToolUseSchema,
    ]),
  ),
  model: z.string(),
  stop_reason: z.enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"]),
  stop_sequence: z.string().nullable(),
  usage: anthropicUsageSchema,
})

/**
 * Validates if a response payload conforms to the Anthropic Message shape.
 * @param payload The response payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidAnthropicResponse(payload: unknown): boolean {
  return anthropicMessageResponseSchema.safeParse(payload).success
}

const anthropicStreamEventSchema = z.looseObject({
  type: z.enum([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]),
})

function isValidAnthropicStreamEvent(payload: unknown): boolean {
  return anthropicStreamEventSchema.safeParse(payload).success
}

describe("OpenAI to Anthropic Non-Streaming Response Translation (basic)", () => {
  test("should translate a simple text response correctly", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello! How can I help you today?",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 12,
        total_tokens: 21,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)

    expect(anthropicResponse.id).toBe("chatcmpl-123")
    expect(anthropicResponse.stop_reason).toBe("end_turn")
    expect(anthropicResponse.usage.input_tokens).toBe(9)
    expect(anthropicResponse.content[0].type).toBe("text")
    if (anthropicResponse.content[0].type === "text") {
      expect(anthropicResponse.content[0].text).toBe(
        "Hello! How can I help you today?",
      )
    } else {
      throw new Error("Expected text block")
    }
  })

  test("should translate a response with tool calls", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-456",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_current_weather",
                  arguments: '{"location": "Boston, MA"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content[0].type).toBe("tool_use")
    if (anthropicResponse.content[0].type === "tool_use") {
      expect(anthropicResponse.content[0].id).toBe("call_abc")
      expect(anthropicResponse.content[0].name).toBe("get_current_weather")
      expect(anthropicResponse.content[0].input).toEqual({
        location: "Boston, MA",
      })
    } else {
      throw new Error("Expected tool_use block")
    }
  })

  test("should translate a response stopped due to length", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-789",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "This is a very long response that was cut off...",
          },
          finish_reason: "length",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2048,
        total_tokens: 2058,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)
    expect(anthropicResponse.stop_reason).toBe("max_tokens")
  })
})

describe("OpenAI to Anthropic Non-Streaming Response Translation (extended)", () => {
  test("should translate only the first choice", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-multi",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "first choice",
          },
          finish_reason: "stop",
          logprobs: null,
        },
        {
          index: 1,
          message: {
            role: "assistant",
            content: "second choice",
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(anthropicResponse.stop_reason).toBe("end_turn")
    expect(anthropicResponse.content).toEqual([
      { type: "text", text: "first choice" },
    ])
  })

  test("should translate OpenAI reasoning fields into thinking blocks", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-thinking",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "output_text", text: "Final answer." },
              {
                type: "reasoning",
                text: "step-by-step reasoning",
                signature: "sig-from-part",
              },
            ],
            reasoning: "fallback reasoning",
            reasoning_signature: "sig-from-message",
            reasoning_details: [
              {
                type: "reasoning",
                text: "detail reasoning",
                signature: "sig-from-detail",
              },
            ],
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(anthropicResponse.content).toContainEqual({
      type: "text",
      text: "Final answer.",
    })
    expect(anthropicResponse.content).toContainEqual({
      type: "thinking",
      thinking: "step-by-step reasoning",
      signature: "sig-from-part",
    })
    expect(anthropicResponse.content).toContainEqual({
      type: "thinking",
      thinking: "fallback reasoning",
      signature: "sig-from-message",
    })
    expect(anthropicResponse.content).toContainEqual({
      type: "thinking",
      thinking: "detail reasoning",
      signature: "sig-from-detail",
    })
  })

  test("should attach message-level signature to reasoning content parts", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-thinking-part-signature",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", text: "hidden chain" },
              { type: "output_text", text: "Visible answer" },
            ],
            reasoning_signature: "sig-from-message",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
        total_tokens: 18,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(anthropicResponse.content).toEqual([
      {
        type: "thinking",
        thinking: "hidden chain",
        signature: "sig-from-message",
      },
      { type: "text", text: "Visible answer" },
    ])
  })

  test("should handle invalid tool call arguments", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-invalid-tool-args",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_invalid",
                type: "function",
                function: {
                  name: "bad_json_tool",
                  arguments: "{not json",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(anthropicResponse.content[0]?.type).toBe("tool_use")
    if (anthropicResponse.content[0]?.type === "tool_use") {
      expect(anthropicResponse.content[0].input).toEqual({})
    }
  })

  test("should keep reasoning blocks when content is null", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-null-content-reasoning",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            reasoning_text: "internal chain of thought",
            reasoning_opaque: "sig-reasoning-1",
            tool_calls: [
              {
                id: "call_reasoning",
                type: "function",
                function: {
                  name: "get_data",
                  arguments: '{"q":"x"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 2,
        total_tokens: 6,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(anthropicResponse.content).toContainEqual({
      type: "thinking",
      thinking: "internal chain of thought",
      signature: "sig-reasoning-1",
    })
    expect(anthropicResponse.content).toContainEqual({
      type: "tool_use",
      id: "call_reasoning",
      name: "get_data",
      input: { q: "x" },
    })
  })

  test("should preserve unsigned reasoning as thinking block without signature", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-unsigned-thinking",
      object: "chat.completion",
      created: 1677652288,
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Visible answer",
            reasoning_text: "unsigned reasoning",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 3,
        total_tokens: 11,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    // Unsigned thinking is preserved (without signature field) so that
    // multi-turn conversations can include the thinking context.
    // Silently dropping reasoning can cause 400 errors on downstream
    // Anthropic endpoints that require thinking blocks in tool_use messages.
    expect(anthropicResponse.content).toEqual([
      { type: "thinking", thinking: "unsigned reasoning" },
      { type: "text", text: "Visible answer" },
    ])
  })
})

describe("OpenAI to Anthropic Streaming Response Translation (basic)", () => {
  test("should translate a simple text stream correctly", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: " there" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
    ]

    const translatedStream = translateFullStream(openAIStream)

    for (const event of translatedStream) {
      expect(isValidAnthropicStreamEvent(event)).toBe(true)
    }
  })

  test("should translate a stream with tool calls", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_xyz",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'ation": "Paris"}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
        ],
      },
    ]

    const translatedStream = translateFullStream(openAIStream)

    for (const event of translatedStream) {
      expect(isValidAnthropicStreamEvent(event)).toBe(true)
    }
  })

  test("should defer message_delta until usage arrives after finish_reason", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-usage-late",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hi" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-usage-late",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
      {
        id: "cmpl-usage-late",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 8,
          total_tokens: 128,
          prompt_tokens_details: {
            cached_tokens: 100,
          },
        },
      },
    ]

    const streamState = createInitialStreamState()
    const finishChunkEvents = translateChunkToAnthropicEvents(
      openAIStream[1],
      streamState,
    )
    expect(
      finishChunkEvents.some((event) => event.type === "message_delta"),
    ).toBe(false)

    const usageChunkEvents = translateChunkToAnthropicEvents(
      openAIStream[2],
      streamState,
    )
    const messageDelta = usageChunkEvents.find(
      (event) => event.type === "message_delta",
    )
    expect(messageDelta).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        cache_read_input_tokens: 100,
      },
    })
    expect(
      usageChunkEvents.some((event) => event.type === "message_stop"),
    ).toBe(true)
  })

  test("should fall back to estimated input tokens when stream ends without usage", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-estimate",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Hi" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-estimate",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
    ]

    const translatedStream = translateFullStream(openAIStream, 42_000)
    const messageStart = translatedStream.find(
      (event) => event.type === "message_start",
    )
    const messageDelta = translatedStream.find(
      (event) => event.type === "message_delta",
    )

    expect(messageStart).toMatchObject({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 42_000,
          output_tokens: 0,
        },
      },
    })
    expect(messageDelta).toMatchObject({
      type: "message_delta",
      usage: {
        input_tokens: 42_000,
        output_tokens: 0,
      },
    })
  })
})

describe("OpenAI to Anthropic Streaming Response Translation (reasoning)", () => {
  test("should emit thinking and signature deltas for reasoning chunks", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-thinking",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              reasoning: "step-1",
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-thinking",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [
                {
                  type: "reasoning",
                  text: " + step-2",
                  signature: "sig-abc",
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-thinking",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { content: " final answer" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-thinking",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
    ]

    const translatedStream = translateFullStream(openAIStream)

    const hasThinkingStart = translatedStream.some(
      (event) =>
        event.type === "content_block_start"
        && event.content_block.type === "thinking",
    )
    // Verify buffered thinking (step-1) is included along with step-2
    const hasThinkingDelta = translatedStream.some(
      (event) =>
        event.type === "content_block_delta"
        && event.delta.type === "thinking_delta"
        && event.delta.thinking.includes("step-1"),
    )
    const hasThinkingDelta2 = translatedStream.some(
      (event) =>
        event.type === "content_block_delta"
        && event.delta.type === "thinking_delta"
        && event.delta.thinking.includes("step-2"),
    )
    const hasSignatureDelta = translatedStream.some(
      (event) =>
        event.type === "content_block_delta"
        && event.delta.type === "signature_delta"
        && event.delta.signature === "sig-abc",
    )
    const hasTextDelta = translatedStream.some(
      (event) =>
        event.type === "content_block_delta"
        && event.delta.type === "text_delta"
        && event.delta.text.includes("final answer"),
    )

    expect(hasThinkingStart).toBe(true)
    expect(hasThinkingDelta).toBe(true)
    expect(hasThinkingDelta2).toBe(true)
    expect(hasSignatureDelta).toBe(true)
    expect(hasTextDelta).toBe(true)
  })

  test("should not emit thinking events when reasoning never gets a signature", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-unsigned-thinking",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              reasoning: "step-1",
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-unsigned-thinking",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { content: " final answer" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-unsigned-thinking",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
    ]

    const translatedStream = translateFullStream(openAIStream)

    const hasThinkingEvent = translatedStream.some(
      (event) =>
        (event.type === "content_block_start"
          && event.content_block.type === "thinking")
        || (event.type === "content_block_delta"
          && (event.delta.type === "thinking_delta"
            || event.delta.type === "signature_delta")),
    )
    const hasTextDelta = translatedStream.some(
      (event) =>
        event.type === "content_block_delta"
        && event.delta.type === "text_delta"
        && event.delta.text.includes("final answer"),
    )

    // Unsigned thinking is emitted as an unsigned thinking block so that
    // OpenAI reasoning models (which never send signatures) can still
    // surface reasoning info to Anthropic protocol clients.
    expect(hasThinkingEvent).toBe(true)
    expect(hasTextDelta).toBe(true)
  })

  test("should flush unsigned thinking before a direct tool_use block", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-thinking-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-opus-4.7",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              reasoning: "step-1",
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-thinking-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-opus-4.7",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: '{"cmd":"pwd"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
      },
    ]

    const translatedStream = translateFullStream(openAIStream)

    expect(translatedStream).toEqual([
      {
        type: "message_start",
        message: {
          id: "cmpl-thinking-tool",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-opus-4.7",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "thinking",
          thinking: "",
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "step-1",
        },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call_1",
          name: "bash",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"cmd":"pwd"}',
        },
      },
      {
        type: "content_block_stop",
        index: 1,
      },
      {
        type: "message_delta",
        delta: {
          stop_reason: "tool_use",
          stop_sequence: null,
        },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
      {
        type: "message_stop",
      },
    ])
  })

  test("should ignore late signatures after text has started", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-late-signature",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { reasoning: "step-1" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-late-signature",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { content: " visible answer" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-late-signature",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { reasoning_signature: "sig-late" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-late-signature",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "claude-sonnet-4",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
    ]

    const translatedStream = translateFullStream(openAIStream)

    const thinkingEvents = translatedStream.filter(
      (event) =>
        (event.type === "content_block_start"
          && event.content_block.type === "thinking")
        || (event.type === "content_block_delta"
          && (event.delta.type === "thinking_delta"
            || event.delta.type === "signature_delta")),
    )
    const textEvents = translatedStream.filter(
      (event) =>
        event.type === "content_block_delta"
        && event.delta.type === "text_delta",
    )

    // Unsigned thinking is emitted before text, late signatures after
    // text has started are still suppressed.
    expect(thinkingEvents).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "step-1" },
      },
    ])
    expect(textEvents).toEqual([
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "text_delta",
          text: " visible answer",
        },
      },
    ])
  })
})
