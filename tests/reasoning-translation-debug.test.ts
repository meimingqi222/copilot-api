/**
 * Diagnostic test: Analyze why thinking/reasoning info from gpt-5.1-codex-mini
 * (a Responses API-only model) is not visible to Anthropic protocol clients.
 *
 * Flow for Responses API-only models called via Anthropic protocol:
 *   1. Anthropic payload → translateToOpenAI() (thinking → reasoning_effort)
 *   2. shouldUseResponsesApi() → true → translateToResponsesPayload()
 *   3. Copilot Responses API returns response
 *   4. translateResponsesToChatCompletion() / translateResponsesStreamToChatCompletions()
 *   5. translateToAnthropic() / translateChunkToAnthropicEvents()
 *   6. Client receives Anthropic response
 *
 * The key question: Does reasoning info survive the full round-trip?
 */
import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import type { ResponsesResponse } from "~/services/copilot/responses-api-types"

import { translateResponsesToChatCompletion } from "~/services/copilot/responses-to-chat"
import {
  createInitialStreamState,
  type AnthropicMessagesPayload,
} from "~/services/protocols/anthropic"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "~/services/protocols/anthropic"
import { translateChunkToAnthropicEvents } from "~/services/protocols/anthropic"

describe("Reasoning translation diagnosis for Responses API models", () => {
  // ============================================================
  // Test 1: Anthropic thinking → OpenAI reasoning_effort
  // ============================================================
  test("Anthropic thinking config is translated to reasoning_effort", () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: "gpt-5.1-codex-mini",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 4096,
      stream: false,
      thinking: { type: "enabled", budget_tokens: 10000 },
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    console.log("=== Test 1: Anthropic → OpenAI payload ===")
    console.log("reasoning_effort:", openAIPayload.reasoning_effort)
    console.log("temperature:", openAIPayload.temperature)

    expect(openAIPayload.reasoning_effort).toBe("high")
    expect(openAIPayload.temperature).toBe(1)
  })

  // ============================================================
  // Test 2: Responses API response → ChatCompletion with reasoning
  // ============================================================
  test("Responses API response with reasoning → ChatCompletion preserves reasoning", () => {
    const responsesResponse: ResponsesResponse = {
      id: "resp_test123",
      model: "gpt-5.1-codex-mini",
      object: "response",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_test",
          summary: [
            {
              type: "summary_text",
              text: "I need to think about this carefully...",
            },
            {
              type: "summary_text",
              text: "Let me analyze the problem step by step.",
            },
          ],
        },
        {
          type: "message",
          id: "msg_test",
          role: "assistant",
          content: [{ type: "output_text", text: "Here is my answer." }],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 200 },
        total_tokens: 350,
      },
    }

    const chatCompletion = translateResponsesToChatCompletion(responsesResponse)
    const message = chatCompletion.choices[0].message

    console.log("\n=== Test 2: Responses → ChatCompletion ===")
    console.log(
      "message.content type:",
      typeof message.content,
      Array.isArray(message.content) ? "array" : "",
    )
    console.log("message.content:", JSON.stringify(message.content, null, 2))
    console.log("message.reasoning_text:", message.reasoning_text)
    console.log("message.reasoning_content:", message.reasoning_content)
    console.log(
      "message.reasoning_details:",
      JSON.stringify(message.reasoning_details),
    )

    // Verify reasoning fields exist
    expect(message.reasoning_text).toBeTruthy()
    expect(message.reasoning_content).toBeTruthy()
  })

  // ============================================================
  // Test 3: ChatCompletion (from Responses API) → Anthropic response
  // ============================================================
  test("ChatCompletion with array content (reasoning + output_text) → Anthropic thinking blocks", () => {
    // This simulates what translateResponsesToChatCompletion produces
    const chatResponse: ChatCompletionResponse = {
      id: "resp_test123",
      object: "chat.completion",
      created: 1234567890,
      model: "gpt-5.1-codex-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "I need to think about this carefully...",
              },
              { type: "reasoning", text: "Let me analyze step by step." },
              { type: "output_text", text: "Here is my answer." },
            ],
            reasoning_content:
              "I need to think about this carefully...Let me analyze step by step.",
            reasoning_text:
              "I need to think about this carefully...Let me analyze step by step.",
            reasoning_details: [
              { text: "I need to think about this carefully..." },
              { text: "Let me analyze step by step." },
            ],
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 350,
      },
    }

    const anthropicResponse = translateToAnthropic(chatResponse)

    console.log("\n=== Test 3: ChatCompletion → Anthropic response ===")
    console.log(
      "Content blocks:",
      JSON.stringify(anthropicResponse.content, null, 2),
    )

    const thinkingBlocks = anthropicResponse.content.filter(
      (b) => b.type === "thinking",
    )
    const textBlocks = anthropicResponse.content.filter(
      (b) => b.type === "text",
    )

    console.log("Thinking blocks count:", thinkingBlocks.length)
    console.log("Text blocks count:", textBlocks.length)

    // KEY CHECK: Are there thinking blocks?
    expect(thinkingBlocks.length).toBeGreaterThan(0)
    expect(textBlocks.length).toBeGreaterThan(0)
  })

  // ============================================================
  // Test 4: Full round-trip (Responses API → ChatCompletion → Anthropic)
  // ============================================================
  test("Full non-streaming round-trip: Responses API → Anthropic", () => {
    // Step 1: Simulate Responses API output
    const responsesResponse: ResponsesResponse = {
      id: "resp_full_test",
      model: "gpt-5.1-codex-mini",
      object: "response",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_full",
          summary: [
            { type: "summary_text", text: "Thinking about the problem..." },
          ],
        },
        {
          type: "message",
          id: "msg_full",
          role: "assistant",
          content: [{ type: "output_text", text: "The answer is 42." }],
        },
      ],
      usage: {
        input_tokens: 50,
        output_tokens: 20,
        total_tokens: 70,
      },
    }

    // Step 2: Responses → ChatCompletion
    const chatCompletion = translateResponsesToChatCompletion(responsesResponse)

    console.log("\n=== Test 4: Full round-trip ===")
    console.log(
      "Step 2 - ChatCompletion message:",
      JSON.stringify(chatCompletion.choices[0].message, null, 2),
    )

    // Step 3: ChatCompletion → Anthropic
    const anthropicResponse = translateToAnthropic(chatCompletion)

    console.log(
      "Step 3 - Anthropic content blocks:",
      JSON.stringify(anthropicResponse.content, null, 2),
    )

    const thinkingBlocks = anthropicResponse.content.filter(
      (b) => b.type === "thinking",
    )
    const textBlocks = anthropicResponse.content.filter(
      (b) => b.type === "text",
    )

    console.log("\n=== DIAGNOSIS RESULT ===")
    console.log("Thinking blocks found:", thinkingBlocks.length)
    console.log("Text blocks found:", textBlocks.length)

    if (thinkingBlocks.length === 0) {
      console.log("❌ PROBLEM: No thinking blocks in Anthropic response!")
      console.log("   Reasoning info is lost during translation.")
      console.log(
        "   Root cause: Check if translateToAnthropic handles array content with 'reasoning' type parts",
      )
    } else {
      console.log("✅ Thinking blocks present in non-streaming response")
      for (const block of thinkingBlocks) {
        if ("thinking" in block) {
          console.log("   Has signature:", Boolean(block.signature))
          if (!block.signature) {
            console.log("   ⚠️  WARNING: No signature on thinking block!")
            console.log(
              "   Some clients may reject thinking blocks without signatures.",
            )
          }
        }
      }
    }

    expect(thinkingBlocks.length).toBeGreaterThan(0)
    expect(textBlocks.length).toBeGreaterThan(0)
  })

  // ============================================================
  // Test 5: Streaming - reasoning_text delta → Anthropic thinking events
  // ============================================================
  test("Streaming: reasoning_text in delta → Anthropic thinking block (no signature)", () => {
    const state = createInitialStreamState()

    // Chunk 1: reasoning content arrives
    const chunk1: ChatCompletionChunk = {
      id: "chunk_1",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "gpt-5.1-codex-mini",
      choices: [
        {
          index: 0,
          delta: {
            reasoning_text: "Thinking about the problem...",
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events1 = translateChunkToAnthropicEvents(chunk1, state)
    console.log("\n=== Test 5: Streaming reasoning_text (no signature) ===")
    console.log(
      "Events after reasoning chunk:",
      JSON.stringify(events1, null, 2),
    )
    console.log(
      "State after reasoning chunk:",
      JSON.stringify({
        bufferedThinking: state.bufferedThinking,
        contentBlockOpen: state.contentBlockOpen,
        currentContentBlockType: state.currentContentBlockType,
      }),
    )

    // Chunk 2: text content arrives (without any signature ever)
    const chunk2: ChatCompletionChunk = {
      id: "chunk_1",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "gpt-5.1-codex-mini",
      choices: [
        {
          index: 0,
          delta: {
            content: "The answer is 42.",
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events2 = translateChunkToAnthropicEvents(chunk2, state)
    console.log("\nEvents after text chunk:", JSON.stringify(events2, null, 2))
    console.log(
      "State after text chunk:",
      JSON.stringify({
        bufferedThinking: state.bufferedThinking,
      }),
    )

    // Chunk 3: finish
    const chunk3: ChatCompletionChunk = {
      id: "chunk_1",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "gpt-5.1-codex-mini",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    }

    const events3 = translateChunkToAnthropicEvents(chunk3, state)
    console.log(
      "\nEvents after finish chunk:",
      JSON.stringify(events3, null, 2),
    )

    // Collect all events
    const allEvents = [...events1, ...events2, ...events3]
    const thinkingEvents = allEvents.filter(
      (e) =>
        e.type === "content_block_start"
        && "content_block" in e
        && e.content_block.type === "thinking",
    )
    const thinkingDeltas = allEvents.filter(
      (e) =>
        e.type === "content_block_delta"
        && "delta" in e
        && e.delta.type === "thinking_delta",
    )

    console.log("\n=== STREAMING DIAGNOSIS ===")
    console.log("Thinking block starts:", thinkingEvents.length)
    console.log("Thinking deltas:", thinkingDeltas.length)

    expect(thinkingEvents.length).toBeGreaterThan(0)
    expect(thinkingDeltas.length).toBeGreaterThan(0)
  })

  // ============================================================
  // Test 6: Streaming with reasoning_details (Responses API translated)
  // ============================================================
  test("Streaming: reasoning via reasoning_content field (Responses→Chat translated)", () => {
    const state = createInitialStreamState()

    // This is what translateResponsesStreamToChatCompletions produces
    // for response.reasoning_summary_text.delta events
    const chunk: ChatCompletionChunk = {
      id: "chunk_rs",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "gpt-5.1-codex-mini",
      choices: [
        {
          index: 0,
          delta: {
            // buildReasoningSummaryDeltaChunk produces these fields:
            reasoning_content: "Thinking step 1...",
            reasoning_text: "Thinking step 1...",
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events = translateChunkToAnthropicEvents(chunk, state)
    console.log(
      "\n=== Test 6: Streaming reasoning_content from Responses API ===",
    )
    console.log("Events:", JSON.stringify(events, null, 2))
    console.log("Buffered thinking:", JSON.stringify(state.bufferedThinking))

    // Now send text
    const textChunk: ChatCompletionChunk = {
      id: "chunk_rs",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "gpt-5.1-codex-mini",
      choices: [
        {
          index: 0,
          delta: { content: "Answer text" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const textEvents = translateChunkToAnthropicEvents(textChunk, state)
    console.log("Events after text:", JSON.stringify(textEvents, null, 2))
    expect(
      textEvents.some(
        (event) =>
          event.type === "content_block_delta"
          && event.delta.type === "text_delta",
      ),
    ).toBe(true)
  })

  // ============================================================
  // Test 7: Verify the getThinkingDelta function recognizes all fields
  // ============================================================
  test("getThinkingDelta recognizes reasoning_content field", () => {
    // The Delta type in create-chat-completions.ts does include reasoning_content
    // but getThinkingDelta in stream-translation.ts uses:
    //   delta.reasoning_text ?? delta.thinking ?? delta.reasoning
    // It does NOT check delta.reasoning_content!
    const state = createInitialStreamState()

    // Simulating a delta with ONLY reasoning_content (what Responses API translation produces)
    const chunkOnlyReasoningContent: ChatCompletionChunk = {
      id: "test_rc",
      object: "chat.completion.chunk",
      created: 1234567890,
      model: "gpt-5.1-codex-mini",
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: "Important reasoning here",
            // reasoning_text is NOT set
          } as ChatCompletionChunk["choices"][number]["delta"],
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events = translateChunkToAnthropicEvents(
      chunkOnlyReasoningContent,
      state,
    )
    console.log("\n=== Test 7: reasoning_content only (no reasoning_text) ===")
    console.log("Events:", JSON.stringify(events, null, 2))
    console.log("Buffered thinking:", JSON.stringify(state.bufferedThinking))

    expect(events.length).toBeGreaterThan(0)
    expect(state.bufferedThinking).toBe("Important reasoning here")
  })

  // ============================================================
  // Test 8: Non-streaming - ChatCompletion with only reasoning_content
  // ============================================================
  test("Non-streaming: message with reasoning_content but no reasoning_text", () => {
    const chatResponse: ChatCompletionResponse = {
      id: "test_ns_rc",
      object: "chat.completion",
      created: 1234567890,
      model: "gpt-5.1-codex-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The answer is 42.",
            // Only reasoning_content, no reasoning_text
            reasoning_content: "Step by step thinking...",
          },
          logprobs: null,
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 20,
        total_tokens: 70,
      },
    }

    const anthropicResponse = translateToAnthropic(chatResponse)
    console.log("\n=== Test 8: Non-streaming reasoning_content only ===")
    console.log(
      "Content blocks:",
      JSON.stringify(anthropicResponse.content, null, 2),
    )

    const thinkingBlocks = anthropicResponse.content.filter(
      (b) => b.type === "thinking",
    )
    console.log("Thinking blocks:", thinkingBlocks.length)

    expect(thinkingBlocks.length).toBe(1)
  })
})
