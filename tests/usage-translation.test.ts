import { describe, test, expect } from "bun:test"

import type { ChatCompletionResponse } from "~/services/protocols/chat/types"

import {
  anthropicUsageToOpenAI,
  openAIUsageToAnthropic,
} from "~/lib/usage-translation"
import {
  decodeChatResponse,
  encodeChatResponse,
  decodeMessagesResponse,
  encodeMessagesResponse,
} from "~/services/ir/codecs/messages-chat/response"
import {
  decodeChatStream,
  decodeMessagesStream,
  encodeMessagesStream,
  encodeChatStream,
} from "~/services/ir/codecs/messages-chat/stream"
import {
  decodeResponsesStream,
  encodeResponsesStream,
} from "~/services/ir/codecs/responses/stream"
import {
  decodeResponsesResult,
  encodeResponsesResult,
} from "~/services/ir/codecs/responses/result"
import { mergeUsage } from "~/services/ir/usage"
import {
  geminiUsage,
  geminiUsageMetadata,
} from "~/services/ir/codecs/gemini/result"

// ── Phase C2.1: openAIUsageToAnthropic unit tests ───────────────────────────

describe("context occupancy is separate from billed usage", () => {
  for (const pending of [true, false, undefined]) {
    test(`public result and stream codecs preserve metadata (pending=${pending})`, async () => {
      const metadata = {
        ...(pending !== undefined && {
          context_window: { used_tokens: 12000, max_tokens: 128000 },
        }),
        ...(pending && { usage_status: "pending" as const }),
      }
      const usage = {
        prompt_tokens: pending ? 0 : 123,
        completion_tokens: pending ? 0 : 7,
        total_tokens: pending ? 0 : 130,
        ...metadata,
      }
      const original = buildChatCompletionResponse(usage)
      const ir = decodeChatResponse(original)
      const messages = encodeMessagesResponse(ir)
      const responses = encodeResponsesResult(ir)
      for (const result of [messages, responses]) {
        expect(result.usage).toMatchObject({
          ...metadata,
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
        })
      }
      for (const back of [
        decodeMessagesResponse(messages),
        decodeResponsesResult(responses),
      ]) {
        expect(encodeChatResponse(back).usage).toMatchObject(usage)
      }
      const frames = () =>
        (async function* () {
          yield {
            data: JSON.stringify({
              id: "test",
              model: "test",
              created: 1,
              object: "chat.completion.chunk",
              choices: [
                { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
              ],
              usage,
            }),
          }
          yield { data: "[DONE]" }
        })()
      const messageFrames = []
      for await (const event of encodeMessagesStream(
        decodeChatStream(frames()),
        999,
      )) {
        messageFrames.push(event)
      }
      expect(
        messageFrames.find((event) => event.type === "message_delta")?.usage,
      ).toMatchObject({
        ...metadata,
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
      })
      const responseFrames = []
      for await (const event of encodeResponsesStream(
        decodeChatStream(frames()),
      )) {
        responseFrames.push(event)
      }
      const completed = responseFrames
        .map((frame) => JSON.parse(frame.data ?? "{}"))
        .find((event) => event.type === "response.completed")
      expect(completed.response.usage).toMatchObject({
        ...metadata,
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
      })
      if (!pending) {
        for (const resultUsage of [
          messages.usage,
          responses.usage,
          messageFrames.find((event) => event.type === "message_delta")?.usage,
          completed.response.usage,
        ]) {
          expect(resultUsage).not.toHaveProperty("usage_status")
          if (pending === undefined)
            expect(resultUsage).not.toHaveProperty("context_window")
        }
      }
      for (const decoded of [
        decodeMessagesStream(
          (async function* () {
            for (const event of messageFrames)
              yield { data: JSON.stringify(event) }
          })(),
        ),
        decodeResponsesStream(
          (async function* () {
            for (const event of responseFrames) yield event
          })(),
          "test",
        ),
      ]) {
        const chatFrames = []
        for await (const event of encodeChatStream(decoded)) {
          if (event.data !== "[DONE]")
            chatFrames.push(JSON.parse(event.data ?? "{}"))
        }
        expect(chatFrames.find((event) => event.usage)?.usage).toMatchObject(
          usage,
        )
      }
    })
  }

  test("shared translators retain metadata and absent extensions do not appear", () => {
    const usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      context_window: { used_tokens: 5000, max_tokens: 32000 },
      usage_status: "pending" as const,
    }
    expect(anthropicUsageToOpenAI(openAIUsageToAnthropic(usage))).toEqual(usage)
    const ordinary = buildChatCompletionResponse({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
    })
    const ir = decodeChatResponse(ordinary)
    for (const result of [
      encodeChatResponse(ir),
      encodeMessagesResponse(ir),
      encodeResponsesResult(ir),
    ]) {
      expect(result.usage).not.toHaveProperty("context_window")
      expect(result.usage).not.toHaveProperty("usage_status")
    }
    expect(
      geminiUsageMetadata(
        geminiUsage({
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          context_window: usage.context_window,
          usage_status: "pending",
        }),
      ),
    ).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      context_window: usage.context_window,
      usage_status: "pending",
    })
  })

  test("snapshot merge replaces occupancy and clears pending when billing arrives", () => {
    const initial = mergeUsage(undefined, {
      source: "reported",
      inputTokens: 0,
      outputTokens: 0,
      usagePending: true,
      contextWindow: { used_tokens: 5000, max_tokens: 32000 },
    })
    const billed = mergeUsage(initial, {
      source: "reported",
      inputTokens: 123,
      outputTokens: 7,
      usagePending: false,
      contextWindow: { used_tokens: 4000, max_tokens: 32000 },
    })
    expect(billed).toMatchObject({
      inputTokens: 123,
      outputTokens: 7,
      usagePending: false,
      contextWindow: { used_tokens: 4000, max_tokens: 32000 },
    })
    expect(mergeUsage(billed, { source: "reported", outputTokens: 0 })).toEqual(
      billed,
    )
    const reported = mergeUsage(initial, {
      source: "reported",
      inputTokens: 0,
      outputTokens: 0,
    })
    expect(reported).not.toHaveProperty("usagePending")
    expect(reported.contextWindow).toEqual(initial.contextWindow)
  })
})

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

// ── anthropicUsageToOpenAI: strict reverse (net + cache buckets = prompt) ────

describe("anthropicUsageToOpenAI", () => {
  test("no cache details at all", () => {
    const result = anthropicUsageToOpenAI({
      input_tokens: 100,
      output_tokens: 10,
    })

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 10,
    })
  })

  test("cache read only folds into prompt_tokens and exposes cached_tokens", () => {
    const result = anthropicUsageToOpenAI({
      input_tokens: 60,
      output_tokens: 10,
      cache_read_input_tokens: 40,
    })

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 40 },
    })
  })

  test("cache creation only folds into prompt_tokens", () => {
    const result = anthropicUsageToOpenAI({
      input_tokens: 70,
      output_tokens: 10,
      cache_creation_input_tokens: 30,
    })

    expect(result).toEqual({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cache_creation_input_tokens: 30 },
    })
  })

  test("both cache buckets fold into prompt_tokens", () => {
    const result = anthropicUsageToOpenAI({
      input_tokens: 200,
      output_tokens: 50,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 200,
    })

    expect(result).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: {
        cached_tokens: 600,
        cache_creation_input_tokens: 200,
      },
    })
  })

  test("round-trips through openAIUsageToAnthropic (conservation invariant)", () => {
    const original: Parameters<typeof anthropicUsageToOpenAI>[0] = {
      input_tokens: 200,
      output_tokens: 50,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 200,
    }

    const backToAnthropic = openAIUsageToAnthropic(
      anthropicUsageToOpenAI(original),
    )
    expect(backToAnthropic).toEqual(original)
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

    const responses = encodeResponsesResult(decodeChatResponse(original))
    const backToChat = encodeChatResponse(decodeResponsesResult(responses))

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

    const responses = encodeResponsesResult(decodeChatResponse(original))
    const backToChat = encodeChatResponse(decodeResponsesResult(responses))

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
