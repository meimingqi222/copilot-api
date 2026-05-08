import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { HTTPError } from "~/lib/error"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import {
  createSsePingInterval,
  forwardSseEvent,
  writeSseEvent,
} from "~/lib/sse"
import { recordUsage } from "~/lib/usage"
import { createResponses } from "~/services/copilot/create-responses"
import { inferInitiatorFromResponsesPayload } from "~/services/copilot/initiator"
import { extractMessageContentFromResponsesPayload } from "~/services/copilot/responses-api"

export async function handleResponses(c: Context) {
  const signal = c.req.raw.signal
  const payload = await c.req.json<ResponsesPayload>()
  const messageContent = extractMessageContentFromResponsesPayload(payload)
  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: payload.model,
    maxTokens:
      typeof payload.max_output_tokens === "number" ?
        payload.max_output_tokens
      : undefined,
    stream: payload.stream === true ? true : undefined,
    inferredInitiator: inferInitiatorFromResponsesPayload(payload),
    messageContent,
  })

  if (payload.stream) {
    return streamSSE(c, async (stream) => {
      const pingInterval = createSsePingInterval(stream)
      let accountId: string | undefined
      let completedResponse: ResponsesResponse | undefined

      try {
        const result = await createResponses(payload, {
          signal,
          initiatorOverride: admission.initiator,
          account: admission.account,
        })
        accountId = result.accountId
        c.set("accountId" as never, result.accountId)

        if (isNonStreaming(result.response)) {
          completedResponse = result.response
          await writeSseEvent(stream, JSON.stringify(result.response))
          return
        }

        for await (const event of result.response) {
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

        if (!completedResponse) {
          await writeResponsesErrorEvent(
            stream,
            new Error("Upstream stream ended without response.completed"),
          )
        }
      } catch (error) {
        if (isAbortError(error) && signal.aborted) {
          return
        }

        await writeResponsesErrorEvent(stream, error)
      } finally {
        clearInterval(pingInterval)
        if (completedResponse && accountId) {
          recordResponsesUsage(c, accountId, completedResponse)
        }
      }
    })
  }

  const result = await createResponses(payload, {
    signal,
    initiatorOverride: admission.initiator,
    account: admission.account,
  })
  c.set("accountId" as never, result.accountId)
  if (!isNonStreaming(result.response)) {
    throw new Error("Expected non-streaming response for non-stream request")
  }

  recordResponsesUsage(c, result.accountId, result.response)
  return c.json(result.response)
}

export function isNonStreaming(
  response: AsyncIterable<CopilotStreamEventLike> | ResponsesResponse,
): response is ResponsesResponse {
  return Object.hasOwn(response, "id") && Object.hasOwn(response, "model")
}

export function recordResponsesUsage(
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

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

export function createResponsesErrorPayload(error: unknown): {
  type: "error"
  error: {
    message: string
    type: string
  }
} {
  const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
  if (knownError) {
    return {
      type: "error",
      error: {
        message: knownError.message,
        type: knownError.type,
      },
    }
  }

  let message = "Internal server error"

  if (error instanceof HTTPError) {
    message = error.responseBody || error.message
  } else if (error instanceof Error) {
    message = error.message
  }

  return {
    type: "error",
    error: {
      message,
      type: "error",
    },
  }
}

async function writeResponsesErrorEvent(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  error: unknown,
): Promise<void> {
  await writeSseEvent(
    stream,
    JSON.stringify(createResponsesErrorPayload(error)),
  )
}
