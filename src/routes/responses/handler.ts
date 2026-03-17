import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { awaitApproval } from "~/lib/approval"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { checkRateLimit, RateLimitQueueFullError } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { incrementUserTokens } from "~/lib/users"
import { createResponses } from "~/services/copilot/create-responses"

interface UsageRecordInput {
  c: Context
  accountId: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export async function handleResponses(c: Context) {
  const signal = c.req.raw.signal

  try {
    await checkRateLimit(signal)
  } catch (error) {
    if (error instanceof RateLimitQueueFullError) {
      return c.json({ error: { message: error.message, type: "error" } }, 503)
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return new Response(null, { status: 499 })
    }
    throw error
  }

  const payload = await c.req.json<ResponsesPayload>()
  const inferredInitiator = inferInitiatorFromResponsesPayload(payload)
  const { initiator } = resolveInitiatorWithClientHeader(c, inferredInitiator)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const result = await createResponses(payload, signal, initiator)
  c.set("accountId" as never, result.accountId)
  c.set("model" as never, payload.model)

  if (isNonStreaming(result.response)) {
    recordResponsesUsage(c, result.accountId, result.response)
    return c.json(result.response)
  }

  let completedResponse: ResponsesResponse | undefined
  const streamResponse = result.response
  return streamSSE(c, async (stream) => {
    for await (const event of streamResponse) {
      if (event.data === "[DONE]") {
        break
      }
      if (!event.data) {
        continue
      }

      const parsed = JSON.parse(event.data) as Record<string, unknown>
      if (
        parsed.type === "response.completed"
        && parsed.response
        && typeof parsed.response === "object"
      ) {
        completedResponse = parsed.response as ResponsesResponse
      }

      await stream.writeSSE({
        ...(event.event ? { event: event.event } : {}),
        data: event.data,
      })
    }

    if (completedResponse) {
      recordResponsesUsage(c, result.accountId, completedResponse)
    }
  })
}

function inferInitiatorFromResponsesPayload(
  payload: ResponsesPayload,
): "agent" | "user" {
  if (typeof payload.input === "string") {
    return "user"
  }

  const lastInput = payload.input.at(-1)
  if (!lastInput) {
    return "user"
  }

  if ("role" in lastInput) {
    return lastInput.role === "assistant" ? "agent" : "user"
  }

  return "agent"
}

function isNonStreaming(
  response: AsyncIterable<CopilotStreamEventLike> | ResponsesResponse,
): response is ResponsesResponse {
  return Object.hasOwn(response, "id") && Object.hasOwn(response, "model")
}

function recordResponsesUsage(
  c: Context,
  accountId: string,
  response: ResponsesResponse,
): void {
  const usage = response.usage
  const model = c.get("model" as never) as string | undefined
  if (!usage || !model) {
    return
  }

  const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0
  const cacheWriteTokens =
    usage.input_tokens_details?.cache_creation_input_tokens ?? 0
  const promptTokens = Math.max((usage.input_tokens ?? 0) - cacheReadTokens, 0)
  recordUsage({
    c,
    accountId,
    model,
    promptTokens,
    completionTokens: usage.output_tokens ?? 0,
    totalTokens:
      usage.total_tokens
      ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    cacheReadTokens,
    cacheWriteTokens,
  })
}

function recordUsage(input: UsageRecordInput): void {
  const {
    c,
    accountId,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
  } = input

  void trackUserTokenUsage(c, totalTokens)

  try {
    const now = Date.now()
    const pricing = statsStore.getModelPricing(model)
    const cost =
      pricing ?
        (promptTokens / 1000) * pricing.promptPricePer1k
        + (completionTokens / 1000) * pricing.completionPricePer1k
        + (cacheReadTokens / 1000) * pricing.cacheReadPricePer1k
        + (cacheWriteTokens / 1000) * pricing.cacheWritePricePer1k
      : 0

    statsStore.recordUsage({
      date: new Date(now).toISOString().split("T")[0] ?? "",
      accountId,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
      timestamp: now,
    })
    consola.debug(
      `Recorded usage: ${model} - ${totalTokens} tokens ($${cost.toFixed(4)})`,
    )
  } catch (error) {
    consola.warn("Failed to record usage:", error)
  }
}

async function trackUserTokenUsage(c: Context, tokens: number): Promise<void> {
  if (tokens <= 0) {
    return
  }

  const userId = c.get("userId" as never) as string | undefined
  if (!userId) {
    return
  }

  try {
    await incrementUserTokens(userId, tokens)
  } catch (error) {
    consola.warn("Failed to track user token usage:", error)
  }
}
