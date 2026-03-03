import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit, RateLimitQueueFullError } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { incrementUserTokens } from "~/lib/users"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import { inferInitiatorFromOpenAIMessages } from "./initiator"

export async function handleCompletion(c: Context) {
  const signal = c.req.raw.signal

  try {
    await checkRateLimit(signal)
  } catch (e) {
    if (e instanceof RateLimitQueueFullError) {
      return c.json({ error: { message: e.message, type: "error" } }, 503)
    }
    if (e instanceof DOMException && e.name === "AbortError") {
      return new Response(null, { status: 499 })
    }
    throw e
  }

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  let estimatedInputTokens = 0
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
      estimatedInputTokens = tokenCount.input + tokenCount.output
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  const initiator = inferInitiatorFromOpenAIMessages(
    payload.messages,
    c.req.header("user-agent"),
  )
  consola.debug("Inferred X-Initiator:", initiator)

  const response = await createChatCompletions(payload, signal, initiator)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    // Track token usage for non-streaming response
    const usage = response.usage
    if (usage) {
      const totalTokens = usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens
      void trackTokenUsage(c, totalTokens)
    } else {
      // Fallback to estimated tokens if usage not available
      void trackTokenUsage(c, estimatedInputTokens)
    }
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined
    try {
      for await (const chunk of response) {
        consola.debug("Streaming chunk:", JSON.stringify(chunk))
        // Capture usage from the final chunk if available
        const chunkWithUsage = chunk as ChatCompletionChunk
        if (chunkWithUsage.usage) {
          lastUsage = chunkWithUsage.usage
        }
        await stream.writeSSE(chunk as SSEMessage)
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        consola.debug("Stream aborted (client disconnected)")
        return
      }
      throw e
    } finally {
      // Track token usage after streaming completes
      if (lastUsage) {
        void trackTokenUsage(c, lastUsage.total_tokens ?? lastUsage.prompt_tokens + lastUsage.completion_tokens)
      } else {
        // Fallback to estimated tokens if no usage data received
        void trackTokenUsage(c, estimatedInputTokens)
      }
    }
  })
}

/**
 * Track token usage for the authenticated user
 */
async function trackTokenUsage(c: Context, tokens: number): Promise<void> {
  if (tokens <= 0) return
  const userId = c.get("userId" as never) as string | undefined
  if (!userId) return
  try {
    await incrementUserTokens(userId, tokens)
    consola.debug(`Tracked ${tokens} tokens for user ${userId}`)
  } catch (error) {
    consola.warn("Failed to track token usage:", error)
  }
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
