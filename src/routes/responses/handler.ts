import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { getAccountForModel } from "~/lib/accounts"
import { awaitApproval } from "~/lib/approval"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { checkAccountRateLimitOrThrow } from "~/lib/request-lifecycle"
import { createSsePingInterval, forwardSseEvent } from "~/lib/sse"
import { state } from "~/lib/state"
import { recordUsage } from "~/lib/usage"
import { createResponses } from "~/services/copilot/create-responses"
import { inferInitiatorFromResponsesPayload } from "~/services/copilot/initiator"

export async function handleResponses(c: Context) {
  const signal = c.req.raw.signal
  const payload = await c.req.json<ResponsesPayload>()
  const account = getAccountForModel(payload.model)

  await checkAccountRateLimitOrThrow(account.id, signal)

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
    const pingInterval = createSsePingInterval(stream)

    try {
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

        await forwardSseEvent(stream, event)
      }
    } finally {
      clearInterval(pingInterval)
      if (completedResponse) {
        recordResponsesUsage(c, result.accountId, completedResponse)
      }
    }
  })
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
