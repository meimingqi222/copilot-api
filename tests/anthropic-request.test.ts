import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic"

import { translateToResponsesPayload } from "../src/services/copilot/chat-to-responses"
import { translateToCopilotMessages } from "../src/services/copilot/create-messages"
import { translateToOpenAI } from "../src/services/protocols/anthropic"

// Zod schema for a single message in the chat completion request.
const messageSchema = z.object({
  role: z.enum([
    "system",
    "user",
    "assistant",
    "tool",
    "function",
    "developer",
  ]),
  content: z.union([z.string(), z.object({}), z.array(z.any())]),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
  reasoning_text: z.string().optional().nullable(),
})

// Zod schema for the entire chat completion request payload.
// This is derived from the openapi.documented.yml specification.
const chatCompletionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1, "Messages array cannot be empty."),
  model: z.string(),
  frequency_penalty: z.number().min(-2).max(2).optional().nullable(),
  logit_bias: z.record(z.string(), z.number()).optional().nullable(),
  logprobs: z.boolean().optional().nullable(),
  top_logprobs: z.number().int().min(0).max(20).optional().nullable(),
  max_tokens: z.number().int().optional().nullable(),
  n: z.number().int().min(1).max(128).optional().nullable(),
  presence_penalty: z.number().min(-2).max(2).optional().nullable(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object", "json_schema"]),
      json_schema: z.object({}).optional(),
    })
    .optional(),
  seed: z.number().int().optional().nullable(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .nullable(),
  stream: z.boolean().optional().nullable(),
  temperature: z.number().min(0).max(2).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.string(), z.object({})]).optional(),
  user: z.string().optional(),
  reasoning_effort: z
    .enum(["minimal", "low", "medium", "high", "xhigh"])
    .optional()
    .nullable(),
  reasoning: z.record(z.string(), z.unknown()).optional().nullable(),
  thinking: z
    .object({
      type: z.literal("enabled"),
      budget_tokens: z.number().int().optional(),
    })
    .optional()
    .nullable(),
})

/**
 * Validates if a request payload conforms to the OpenAI Chat Completion v1 shape using Zod.
 * @param payload The request payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidChatCompletionRequest(payload: unknown): boolean {
  const result = chatCompletionRequestSchema.safeParse(payload)
  return result.success
}

describe("Anthropic to OpenAI translation logic", () => {
  test("should translate minimal Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should translate comprehensive Anthropic payload to valid OpenAI payload", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "What is the weather like in Boston?" },
        {
          role: "assistant",
          content: "The weather in Boston is sunny and 75°F.",
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      stream: false,
      metadata: { user_id: "user-123" },
      tools: [
        {
          name: "getWeather",
          description: "Gets weather info",
          input_schema: { location: { type: "string" } },
        },
      ],
      tool_choice: { type: "auto" },
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should strip x-anthropic-billing-header from system string", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      system: "x-anthropic-billing-header:cch=abcde\n\nYou are helpful.",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(openAIPayload.messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    })
  })

  test("should strip x-anthropic-billing-header from system block array", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      system: [
        { type: "text", text: "x-anthropic-billing-header:cch=abcde" },
        { type: "text", text: "You are helpful." },
      ],
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(openAIPayload.messages[0]).toEqual({
      role: "system",
      content: "You are helpful.",
    })
  })

  test("should handle missing fields gracefully", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      max_tokens: 0,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test("should handle invalid types in Anthropic payload", () => {
    const anthropicPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot", // Should be a number
    }
    // @ts-expect-error intended to be invalid
    const openAIPayload = translateToOpenAI(anthropicPayload)
    // Should fail validation
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(false)
  })

  test("should handle thinking blocks in assistant messages", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What is 2+2?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this simple math problem...",
            },
            { type: "text", text: "2+2 equals 4." },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Historical assistant messages must not carry reasoning_text.
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.content).toBe("2+2 equals 4.")
    expect(assistantMessage?.reasoning_text).toBeUndefined()
  })

  test("should handle thinking blocks with tool calls", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking:
                "I need to call the weather API to get current weather information.",
            },
            { type: "text", text: "I'll check the weather for you." },
            {
              type: "tool_use",
              id: "call_123",
              name: "get_weather",
              input: { location: "New York" },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // reasoning_text is stripped for all historical assistant messages.
    const assistantMessage = openAIPayload.messages.find(
      (m) => m.role === "assistant",
    )
    expect(assistantMessage?.reasoning_text).toBeUndefined()
    expect(assistantMessage?.content).toBe("I'll check the weather for you.")
    expect(assistantMessage?.tool_calls).toHaveLength(1)
    expect(assistantMessage?.tool_calls?.[0].function.name).toBe("get_weather")
  })

  test("should preserve visible text while stripping thinking from assistant history", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "First text." },
            { type: "thinking", thinking: "First thinking." },
            { type: "text", text: "Second text." },
            { type: "thinking", thinking: "Second thinking." },
          ],
        },
      ],
      max_tokens: 100,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    const assistantMessage = openAIPayload.messages[0]

    expect(assistantMessage.role).toBe("assistant")
    expect(assistantMessage.content).toBe("First text.\n\nSecond text.")
    expect(assistantMessage.reasoning_text).toBeUndefined()
  })

  test("should strip reasoning_text from historical assistant messages without tool calls", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-3-5-sonnet-20241022",
      messages: [
        { role: "user", content: "Round 1 question" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should reason before answering." },
            { type: "text", text: "Round 1 answer" },
          ],
        },
        { role: "user", content: "Round 2 question" },
      ],
      max_tokens: 128,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    const historicalAssistantMessage = openAIPayload.messages[1]

    expect(historicalAssistantMessage.role).toBe("assistant")
    expect(historicalAssistantMessage.content).toBe("Round 1 answer")
    expect(historicalAssistantMessage.reasoning_text).toBeUndefined()
    expect(historicalAssistantMessage.tool_calls).toBeUndefined()
  })
})

describe("Anthropic thinking and model mapping", () => {
  test("should pass thinking configuration to OpenAI reasoning fields", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "enabled",
        budget_tokens: 512,
      },
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.reasoning_effort).toBe("minimal")
    expect(openAIPayload.temperature).toBe(1)
    expect(openAIPayload.thinking).toBeUndefined()
    expect(openAIPayload.reasoning).toBeUndefined()
  })

  test("should omit reasoning_effort for adaptive thinking configuration", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "adaptive",
      },
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    // "auto" is not a valid reasoning_effort value for most upstreams;
    // adaptive → omit so each upstream falls back to its own default.
    expect(openAIPayload.reasoning_effort).toBeUndefined()
    // Reasoning not force-enabled → original temperature is preserved.
    expect(openAIPayload.temperature).toBeUndefined()
    expect(openAIPayload.thinking).toBeUndefined()
    expect(openAIPayload.reasoning).toBeUndefined()
  })

  test("strips historical thinking by default, preserves as reasoning_content when opted in", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "step 1" },
            { type: "text", text: "thought done" },
          ],
        },
        { role: "user", content: "continue" },
      ],
      max_tokens: 128,
    }

    // Default (Copilot path): historical thinking is stripped.
    const stripped = translateToOpenAI(anthropicPayload)
    expect(stripped.messages[0]).toMatchObject({
      role: "assistant",
      content: "thought done",
    })
    expect(stripped.messages[0].reasoning_content).toBeUndefined()

    // Opt-in (non-Copilot path): preserved for DeepSeek/Kimi/Qwen/xAI.
    const preserved = translateToOpenAI(anthropicPayload, {
      preserveHistoricalReasoning: true,
    })
    expect(preserved.messages[0]).toMatchObject({
      role: "assistant",
      content: "thought done",
      reasoning_content: "step 1",
    })
  })

  test("preserves historical thinking alongside tool_calls when opted in", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "bash",
              input: { cmd: "pwd" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "/home" },
          ],
        },
      ],
      max_tokens: 128,
    }

    const preserved = translateToOpenAI(anthropicPayload, {
      preserveHistoricalReasoning: true,
    })

    expect(preserved.messages[0]).toMatchObject({
      role: "assistant",
      content: null,
      reasoning_content: "plan",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "bash", arguments: '{"cmd":"pwd"}' },
        },
      ],
    })
    // tool_result still becomes a role:"tool" message.
    expect(preserved.messages[1]).toMatchObject({ role: "tool" })
  })

  test("should handle boundary values for budget_tokens in OpenAI translation", () => {
    const testCases = [
      { budget: 0, expected: "none" },
      { budget: 512, expected: "minimal" },
      { budget: 513, expected: "low" },
      { budget: 1024, expected: "low" },
      { budget: 1025, expected: "medium" },
      { budget: 8192, expected: "medium" },
      { budget: 8193, expected: "high" },
      { budget: 24576, expected: "high" },
      { budget: 24577, expected: "xhigh" },
      { budget: 100000, expected: "xhigh" },
    ]

    for (const { budget, expected } of testCases) {
      const anthropicPayload: AnthropicMessagesPayload = {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 128,
        thinking: {
          type: "enabled",
          budget_tokens: budget,
        },
      }

      const openAIPayload = translateToOpenAI(anthropicPayload)
      expect(openAIPayload.reasoning_effort).toBe(
        expected as "none" | "minimal" | "low" | "medium" | "high" | "xhigh",
      )
    }
  })

  test("omits explicit none while preserving budget-zero none", () => {
    const explicitNone = translateToOpenAI({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      reasoning_effort: "none",
    })
    expect(explicitNone.reasoning_effort).toBeUndefined()

    const budgetZero = translateToOpenAI({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: { type: "enabled", budget_tokens: 0 },
    })
    expect(budgetZero.reasoning_effort).toBe("none")
  })

  test("should override temperature to 1 when thinking is enabled in OpenAI translation", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      temperature: 0.3,
      thinking: {
        type: "enabled",
        budget_tokens: 8192,
      },
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.temperature).toBe(1)
    expect(openAIPayload.reasoning_effort).toBe("medium")
  })

  test("should preserve original temperature when thinking is not enabled in OpenAI translation", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      temperature: 0.7,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.temperature).toBe(0.7)
    expect(openAIPayload.reasoning_effort).toBeUndefined()
  })

  test("should normalize only numeric claude snapshot model suffixes", () => {
    const numericSnapshotPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
    }
    const minorVersionPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
    }
    const nonNumericSuffixPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-x",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
    }

    const normalized = translateToOpenAI(numericSnapshotPayload)
    const minorVersion = translateToOpenAI(minorVersionPayload)
    const preserved = translateToOpenAI(nonNumericSuffixPayload)

    expect(normalized.model).toBe("claude-sonnet-4")
    expect(minorVersion.model).toBe("claude-sonnet-4-6")
    expect(preserved.model).toBe("claude-sonnet-4-x")
  })
})

describe("Copilot /v1/messages endpoint translation", () => {
  test("should not include reasoning_effort in output (OpenAI-specific param)", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "enabled",
        budget_tokens: 8192,
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    // reasoning_effort is OpenAI-specific, should not be sent to Copilot's Anthropic endpoint
    expect(copilotPayload.reasoning_effort).toBeUndefined()
    // thinking is Anthropic's native param, should be preserved
    expect(copilotPayload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 8192,
    })
  })

  test("should not include reasoning_effort when reasoning_effort is provided in input", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      reasoning_effort: "high",
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    // reasoning_effort should be stripped
    expect(copilotPayload.reasoning_effort).toBeUndefined()
  })

  test("should preserve thinking configuration", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "enabled",
        budget_tokens: 16000,
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    // thinking should be preserved as-is
    expect(copilotPayload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 16000,
    })
  })

  test("should preserve adaptive thinking", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "adaptive",
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    expect(copilotPayload.thinking).toEqual({ type: "adaptive" })
  })

  test("should preserve output_config effort for adaptive thinking models", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-opus-4.7",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "adaptive",
      },
      output_config: {
        effort: "medium",
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    // opus-4.7 with adaptive thinking: display: "summarized" is added automatically
    expect(copilotPayload.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    })
    expect(copilotPayload.output_config).toEqual({
      effort: "medium",
    })
    expect(copilotPayload.reasoning_effort).toBeUndefined()
  })

  test("should not add reasoning_effort when thinking is not specified", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      temperature: 0.5,
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    expect(copilotPayload.reasoning_effort).toBeUndefined()
    expect(copilotPayload.temperature).toBe(0.5)
  })

  test("should preserve all other payload fields", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      system: "You are helpful.",
      metadata: { user_id: "user-123" },
      stop_sequences: ["stop"],
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      tools: [{ name: "test", input_schema: {} }],
      tool_choice: { type: "auto" },
      thinking: {
        type: "enabled",
        budget_tokens: 1024,
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    expect(copilotPayload.model).toBe("claude-sonnet-4")
    expect(copilotPayload.messages).toEqual([
      { role: "user", content: "hello" },
    ])
    expect(copilotPayload.max_tokens).toBe(128)
    expect(copilotPayload.system).toBe("You are helpful.")
    expect(copilotPayload.metadata).toEqual({ user_id: "user-123" })
    expect(copilotPayload.stop_sequences).toEqual(["stop"])
    expect(copilotPayload.stream).toBe(true)
    expect(copilotPayload.top_p).toBe(0.9)
    expect(copilotPayload.top_k).toBe(40)
    expect(copilotPayload.tools).toHaveLength(1)
    expect(copilotPayload.tool_choice).toEqual({ type: "auto" })
    expect(copilotPayload.reasoning_effort).toBeUndefined()
    expect(copilotPayload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    })
    expect(copilotPayload.temperature).toBe(0.7)
  })

  test("should preserve original temperature", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      temperature: 0.7,
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    expect(copilotPayload.temperature).toBe(0.7)
    expect(copilotPayload.reasoning_effort).toBeUndefined()
  })
})

describe("Responses API endpoint translation (through OpenAI payload)", () => {
  test("should translate reasoning_effort to Responses reasoning format", () => {
    const openAIPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user" as const, content: "hello" }],
      max_tokens: 128,
      reasoning_effort: "high" as const,
    }

    const responsesPayload = translateToResponsesPayload(openAIPayload)

    expect(responsesPayload.reasoning).toEqual({
      effort: "high",
      summary: "auto",
    })
  })

  test("should normalize reasoning_effort values for Responses API", () => {
    const testCases = [
      { input: "minimal" as const, expected: "low" as const },
      { input: "low" as const, expected: "low" as const },
      { input: "medium" as const, expected: "medium" as const },
      { input: "high" as const, expected: "high" as const },
      { input: "xhigh" as const, expected: "high" as const },
    ]

    for (const { input, expected } of testCases) {
      const openAIPayload = {
        model: "claude-sonnet-4",
        messages: [{ role: "user" as const, content: "test" }],
        max_tokens: 128,
        reasoning_effort: input,
      }

      const responsesPayload = translateToResponsesPayload(openAIPayload)
      expect(responsesPayload.reasoning?.effort).toBe(expected)
    }
  })

  test("should not include reasoning when reasoning_effort is not specified", () => {
    const openAIPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user" as const, content: "hello" }],
      max_tokens: 128,
    }

    const responsesPayload = translateToResponsesPayload(openAIPayload)

    expect(responsesPayload.reasoning).toBeUndefined()
  })

  test("should preserve other fields in Responses payload", () => {
    const openAIPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: "hi there" },
      ],
      max_tokens: 256,
      temperature: 0.7,
      top_p: 0.9,
      stream: true,
      reasoning_effort: "medium" as const,
      tools: [
        {
          type: "function" as const,
          function: { name: "test", parameters: {} },
        },
      ],
    }

    const responsesPayload = translateToResponsesPayload(openAIPayload)

    expect(responsesPayload.model).toBe("claude-sonnet-4")
    expect(responsesPayload.max_output_tokens).toBe(256)
    expect(responsesPayload.temperature).toBe(0.7)
    expect(responsesPayload.top_p).toBe(0.9)
    expect(responsesPayload.stream).toBe(true)
    expect(responsesPayload.reasoning).toEqual({
      effort: "medium",
      summary: "auto",
    })
    expect(responsesPayload.tools).toHaveLength(1)
  })
})

describe("OpenAI Chat Completion v1 Request Payload Validation with Zod", () => {
  test("should return true for a minimal valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test("should return true for a comprehensive valid request payload", () => {
    const validPayload = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the weather like in Boston?" },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
      n: 1,
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test('should return false if the "model" field is missing', () => {
    const invalidPayload = {
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" field is missing', () => {
    const invalidPayload = {
      model: "gpt-4o",
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" array is empty', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "model" is not a string', () => {
    const invalidPayload = {
      model: 12345,
      messages: [{ role: "user", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "messages" is not an array', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: { role: "user", content: "Hello!" },
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing a "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing "content"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user" }],
    }
    // Note: Zod considers 'undefined' as missing, so this will fail as expected.
    const result = chatCompletionRequestSchema.safeParse(invalidPayload)
    expect(result.success).toBe(false)
  })

  test('should return false if a message has an invalid "role"', () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "customer", content: "Hello!" }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false if an optional field has an incorrect type", () => {
    const invalidPayload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello!" }],
      temperature: "hot", // Should be a number
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false for a completely empty object", () => {
    const invalidPayload = {}
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test("should return false for null or non-object payloads", () => {
    expect(isValidChatCompletionRequest(null)).toBe(false)
    expect(isValidChatCompletionRequest(undefined)).toBe(false)
    expect(isValidChatCompletionRequest("a string")).toBe(false)
    expect(isValidChatCompletionRequest(123)).toBe(false)
  })
})
