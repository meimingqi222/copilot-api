import { describe, test, expect } from "bun:test"

import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import { openAIUsageToAnthropic } from "~/lib/usage-translation"
import { translateChatCompletionToResponses } from "~/services/copilot/chat-to-responses"
import { translateResponsesToChatCompletion } from "~/services/copilot/responses-to-chat"

// ── Phase C2.1: openAIUsageToAnthropic unit tests ───────────────────────────

describe("openAIUsageToAnthropic", () => {
  test("no cache details at all", () => {
    const result = openAIUsageToAnthropic({
      prompt_tokens: 100,
      completion_tokens: 10,
    })

    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 10,
    })
  })

  test("cached_tokens only (cache read, no cache creation)", () => {
    const result = openAIUsageToAnthropic({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 40 },
    })

    expect(result).toEqual({
      input_tokens: 60,
      output_tokens: 10,
      cache_read_input_tokens: 40,
    })
    // Conservation: net input + cache_read + output == total input + output
    expect(
      result.input_tokens
        + (result.cache_read_input_tokens ?? 0)
        + result.output_tokens,
    ).toBe(100 + 10)
  })

  test("cache_creation_input_tokens only (cache write, no cache read)", () => {
    const result = openAIUsageToAnthropic({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cache_creation_input_tokens: 30 },
    })

    expect(result).toEqual({
      input_tokens: 70,
      output_tokens: 10,
      cache_creation_input_tokens: 30,
    })
    expect(
      result.input_tokens
        + (result.cache_creation_input_tokens ?? 0)
        + result.output_tokens,
    ).toBe(100 + 10)
  })

  test("both cached_tokens and cache_creation_input_tokens present", () => {
    const result = openAIUsageToAnthropic({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: {
        cached_tokens: 600,
        cache_creation_input_tokens: 200,
      },
    })

    expect(result).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 200,
    })
    expect(
      result.input_tokens
        + (result.cache_read_input_tokens ?? 0)
        + (result.cache_creation_input_tokens ?? 0)
        + result.output_tokens,
    ).toBe(1000 + 50)
  })

  test("clamps to 0 when cache totals exceed prompt_tokens", () => {
    const result = openAIUsageToAnthropic({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: {
        cached_tokens: 80,
        cache_creation_input_tokens: 50,
      },
    })

    expect(result.input_tokens).toBe(0)
  })
})

// ── Phase C2.3: Anthropic-direction regression test ─────────────────────────

describe("openAIUsageToAnthropic (Anthropic regression)", () => {
  test("prompt=1000, cached=600, cache_creation=200, completion=50", () => {
    const result = openAIUsageToAnthropic({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: {
        cached_tokens: 600,
        cache_creation_input_tokens: 200,
      },
    })

    expect(result.input_tokens).toBe(200)
    expect(result.cache_read_input_tokens).toBe(600)
    expect(result.cache_creation_input_tokens).toBe(200)
    expect(result.output_tokens).toBe(50)

    const total =
      result.input_tokens
      + (result.cache_read_input_tokens ?? 0)
      + (result.cache_creation_input_tokens ?? 0)
      + result.output_tokens
    expect(total).toBe(1050)
  })
})

// ── Phase C2.2: chat <-> responses usage round trip ─────────────────────────

function buildChatCompletionResponse(
  usage: ChatCompletionResponse["usage"],
): ChatCompletionResponse {
  return {
    id: "chatcmpl-round-trip",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello" },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage,
  }
}

describe("chat -> responses -> chat usage round trip", () => {
  test("prompt_tokens, completion_tokens, and cached_tokens survive the round trip", () => {
    const original = buildChatCompletionResponse({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: {
        cached_tokens: 600,
        cache_creation_input_tokens: 200,
      },
    })

    const responses = translateChatCompletionToResponses(original)
    const backToChat = translateResponsesToChatCompletion(responses)

    expect(backToChat.usage?.prompt_tokens).toBe(1000)
    expect(backToChat.usage?.completion_tokens).toBe(50)
    expect(backToChat.usage?.prompt_tokens_details?.cached_tokens).toBe(600)

    // Previously lost in the responses -> chat direction; this is the C2
    // fix — cache_creation must round-trip too, otherwise a second pass
    // through openAIUsageToAnthropic would double-count the cache-write
    // tokens as ordinary (net) input tokens.
    expect(
      backToChat.usage?.prompt_tokens_details?.cache_creation_input_tokens,
    ).toBe(200)
  })

  test("round-tripped usage still satisfies the Anthropic conservation invariant", () => {
    const original = buildChatCompletionResponse({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: {
        cached_tokens: 600,
        cache_creation_input_tokens: 200,
      },
    })

    const responses = translateChatCompletionToResponses(original)
    const backToChat = translateResponsesToChatCompletion(responses)

    const anthropicUsage = openAIUsageToAnthropic({
      prompt_tokens: backToChat.usage?.prompt_tokens ?? 0,
      completion_tokens: backToChat.usage?.completion_tokens ?? 0,
      prompt_tokens_details: backToChat.usage?.prompt_tokens_details,
    })

    expect(anthropicUsage).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 200,
    })
  })
})
