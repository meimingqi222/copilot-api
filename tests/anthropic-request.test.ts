import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { translateToOpenAI } from "../src/routes/messages/non-stream-translation"
import { translateToCopilotMessages } from "../src/services/copilot/create-messages"
import { translateToResponsesPayload } from "../src/services/copilot/chat-to-responses"

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

  test("should map adaptive thinking configuration to OpenAI reasoning fields", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "adaptive",
      },
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)

    expect(openAIPayload.reasoning_effort).toBe("high")
    expect(openAIPayload.temperature).toBe(1)
    expect(openAIPayload.thinking).toBeUndefined()
    expect(openAIPayload.reasoning).toBeUndefined()
  })

  test("should handle boundary values for budget_tokens in OpenAI translation", () => {
    const testCases = [
      { budget: 0, expected: "minimal" },
      { budget: 1023, expected: "minimal" },
      { budget: 1024, expected: "low" },
      { budget: 8191, expected: "low" },
      { budget: 8192, expected: "medium" },
      { budget: 24575, expected: "medium" },
      { budget: 24576, expected: "high" },
      { budget: 32767, expected: "high" },
      { budget: 32768, expected: "xhigh" },
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
      expect(openAIPayload.reasoning_effort).toBe(expected)
    }
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
  test("should translate thinking.budget_tokens to reasoning_effort for minimal", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "enabled",
        budget_tokens: 512,
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    expect(copilotPayload.reasoning_effort).toBe("minimal")
    expect(copilotPayload.temperature).toBe(1)
    expect(copilotPayload.thinking).toBeUndefined()
  })

  test("should translate thinking.budget_tokens to reasoning_effort for low", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "enabled",
        budget_tokens: 2000,
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    expect(copilotPayload.reasoning_effort).toBe("low")
    expect(copilotPayload.temperature).toBe(1)
  })

  test("should translate thinking.budget_tokens to reasoning_effort for medium (default)", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "enabled",
        budget_tokens: 10000,
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    expect(copilotPayload.reasoning_effort).toBe("medium")
    expect(copilotPayload.temperature).toBe(1)
  })

  test("should translate thinking.budget_tokens to reasoning_effort for high", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "enabled",
        budget_tokens: 25000,
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    expect(copilotPayload.reasoning_effort).toBe("high")
    expect(copilotPayload.temperature).toBe(1)
  })

  test("should translate thinking.budget_tokens to reasoning_effort for xhigh", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "enabled",
        budget_tokens: 40000,
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    expect(copilotPayload.reasoning_effort).toBe("xhigh")
    expect(copilotPayload.temperature).toBe(1)
  })

  test("should translate thinking with default budget_tokens when not specified", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "enabled",
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    // Default budget is 8192, which maps to medium
    expect(copilotPayload.reasoning_effort).toBe("medium")
    expect(copilotPayload.temperature).toBe(1)
  })

  test("should translate adaptive thinking to high reasoning_effort", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
      thinking: {
        type: "adaptive",
      },
    }

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    expect(copilotPayload.reasoning_effort).toBe("high")
    expect(copilotPayload.temperature).toBe(1)
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
    expect(copilotPayload.messages).toEqual([{ role: "user", content: "hello" }])
    expect(copilotPayload.max_tokens).toBe(128)
    expect(copilotPayload.system).toBe("You are helpful.")
    expect(copilotPayload.metadata).toEqual({ user_id: "user-123" })
    expect(copilotPayload.stop_sequences).toEqual(["stop"])
    expect(copilotPayload.stream).toBe(true)
    expect(copilotPayload.top_p).toBe(0.9)
    expect(copilotPayload.top_k).toBe(40)
    expect(copilotPayload.tools).toHaveLength(1)
    expect(copilotPayload.tool_choice).toEqual({ type: "auto" })
    expect(copilotPayload.reasoning_effort).toBe("low")
    expect(copilotPayload.temperature).toBe(1)
  })

  test("should handle boundary values for budget_tokens", () => {
    // Test exact boundary values
    const testCases = [
      { budget: 0, expected: "minimal" },
      { budget: 1023, expected: "minimal" },
      { budget: 1024, expected: "low" },
      { budget: 8191, expected: "low" },
      { budget: 8192, expected: "medium" },
      { budget: 24575, expected: "medium" },
      { budget: 24576, expected: "high" },
      { budget: 32767, expected: "high" },
      { budget: 32768, expected: "xhigh" },
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

      const copilotPayload = translateToCopilotMessages(anthropicPayload)
      expect(copilotPayload.reasoning_effort).toBe(expected)
    }
  })

  test("should override temperature to 1 when thinking is enabled", () => {
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

    const copilotPayload = translateToCopilotMessages(anthropicPayload)

    // temperature should be overridden to 1 when reasoning is enabled
    expect(copilotPayload.temperature).toBe(1)
    expect(copilotPayload.reasoning_effort).toBe("medium")
  })

  test("should preserve original temperature when thinking is not enabled", () => {
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

  test("should not include thinking field in output", () => {
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

    // thinking field should be removed, replaced with reasoning_effort
    expect(copilotPayload.thinking).toBeUndefined()
    expect(copilotPayload.reasoning_effort).toBe("medium")
  })
})

describe("Responses API endpoint translation (through OpenAI payload)", () => {
  test("should translate reasoning_effort to Responses reasoning format", () => {
    const openAIPayload = {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
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
        messages: [{ role: "user", content: "test" }],
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
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
    }

    const responsesPayload = translateToResponsesPayload(openAIPayload)

    expect(responsesPayload.reasoning).toBeUndefined()
  })

  test("should preserve other fields in Responses payload", () => {
    const openAIPayload = {
      model: "claude-sonnet-4",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      max_tokens: 256,
      temperature: 0.7,
      top_p: 0.9,
      stream: true,
      reasoning_effort: "medium" as const,
      tools: [{ type: "function" as const, function: { name: "test", parameters: {} } }],
    }

    const responsesPayload = translateToResponsesPayload(openAIPayload)

    expect(responsesPayload.model).toBe("claude-sonnet-4")
    expect(responsesPayload.max_output_tokens).toBe(256)
    expect(responsesPayload.temperature).toBe(0.7)
    expect(responsesPayload.top_p).toBe(0.9)
    expect(responsesPayload.stream).toBe(true)
    expect(responsesPayload.reasoning).toEqual({ effort: "medium", summary: "auto" })
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
