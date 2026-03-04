import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
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

interface StreamResult {
  accountId: string
  // Raw SSE events from fetch-event-stream, needs JSON parsing
  response: AsyncIterable<{ data?: string }> | ChatCompletionResponse
  estimatedInputTokens: number
}

export async function handleCompletion(c: Context) {
  const signal = c.req.raw.signal

  await checkRateLimitOrThrow(signal)

  const result = await processRequest(c, signal)
  const { accountId, response, estimatedInputTokens } = result

  // Set accountId for logging
  c.set("accountId" as never, accountId)

  if (isChatCompletionResponse(response)) {
    handleNonStreamingResponse(c, response, estimatedInputTokens)
    return c.json(response)
  }

  return handleStreamingResponse(c, response, estimatedInputTokens)
}

async function checkRateLimitOrThrow(signal: AbortSignal): Promise<void> {
  try {
    await checkRateLimit(signal)
  } catch (e) {
    if (e instanceof RateLimitQueueFullError) {
      throw new RateLimitError(e.message)
    }
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new AbortError()
    }
    throw e
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RateLimitError"
  }
}

export class AbortError extends Error {
  constructor() {
    super("Abort")
    this.name = "AbortError"
  }
}

async function processRequest(
  c: Context,
  signal: AbortSignal,
): Promise<StreamResult> {
  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  const estimatedInputTokens = await calculateTokens(payload, selectedModel)

  if (state.manualApprove) await awaitApproval()

  payload = applyMaxTokens(payload, selectedModel)

  const initiator = resolveInitiator(c, payload)

  const result = await createChatCompletions(payload, signal, initiator)

  return {
    accountId: result.accountId,
    response: result.response,
    estimatedInputTokens,
  }
}

async function calculateTokens(
  payload: ChatCompletionsPayload,
  selectedModel: (typeof state.models.data)[number] | undefined,
): Promise<number> {
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
      return tokenCount.input + tokenCount.output
    }
    consola.warn("No model selected, skipping token count calculation")
    return 0
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
    return 0
  }
}

function applyMaxTokens(
  payload: ChatCompletionsPayload,
  selectedModel: (typeof state.models.data)[number] | undefined,
): ChatCompletionsPayload {
  if (isNullish(payload.max_tokens)) {
    const newPayload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(newPayload.max_tokens))
    return newPayload
  }
  return payload
}

function resolveInitiator(
  c: Context,
  payload: ChatCompletionsPayload,
): "agent" | "user" | undefined {
  const inferredInitiator = inferInitiatorFromOpenAIMessages(
    payload.messages,
    c.req.header("user-agent"),
  )
  const { clientInitiator, initiator, trustedClientAgent } =
    resolveInitiatorWithClientHeader(c, inferredInitiator)
  consola.debug(
    "X-Initiator: client=%s trusted_agent=%s final=%s",
    clientInitiator ?? "(none)",
    trustedClientAgent,
    initiator,
  )
  return initiator
}

function handleNonStreamingResponse(
  c: Context,
  response: ChatCompletionResponse,
  estimatedInputTokens: number,
): void {
  consola.debug("Non-streaming response:", JSON.stringify(response))
  const usage = response.usage
  if (usage) {
    const totalTokens =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens
    void trackTokenUsage(c, totalTokens)
  } else {
    void trackTokenUsage(c, estimatedInputTokens)
  }
}

function handleStreamingResponse(
  c: Context,
  response: AsyncIterable<{ data?: string }>,
  estimatedInputTokens: number,
) {
  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    let lastUsage: UsageInfo | undefined
    let trackedInAbort = false
    try {
      for await (const rawEvent of response) {
        consola.debug("Streaming raw event:", JSON.stringify(rawEvent))
        if (rawEvent.data === "[DONE]") {
          break
        }
        if (!rawEvent.data) {
          continue
        }
        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        if (chunk.usage) {
          lastUsage = chunk.usage
        }
        await stream.writeSSE({
          data: JSON.stringify(chunk),
        } as SSEMessage)
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        consola.debug("Stream aborted (client disconnected)")
        if (lastUsage) {
          trackedInAbort = true
          void trackTokenUsage(c, calculateTotalTokens(lastUsage))
        }
        return
      }
      throw e
    } finally {
      if (!trackedInAbort) {
        if (lastUsage) {
          void trackTokenUsage(c, calculateTotalTokens(lastUsage))
        } else {
          void trackTokenUsage(c, estimatedInputTokens)
        }
      }
    }
  })
}

interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

function calculateTotalTokens(usage: UsageInfo): number {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens
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

const isChatCompletionResponse = (
  response: AsyncIterable<{ data?: string }> | ChatCompletionResponse,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
