import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { extractErrorMessage } from "~/lib/error-builder"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import {
  createSsePingInterval,
  forwardSseEvent,
  writeSseEvent,
} from "~/lib/sse"
import { identityFromAdmission } from "~/lib/usage"
import {
  applyUsageIdentity,
  type UsageIdentity,
  recordUsage,
} from "~/lib/usage"
import { isAbortError } from "~/lib/utils"
import { inferInitiatorFromResponsesPayload } from "~/services/copilot/initiator"
import { extractMessageContentFromResponsesPayload } from "~/services/copilot/responses-api"
import { dispatchResponses } from "~/services/dispatch/responses"

type ResponsesExecutionResult =
  | {
      accountId: string
      response: AsyncIterable<CopilotStreamEventLike>
      identity?: UsageIdentity
    }
  | { accountId: string; response: ResponsesResponse; identity?: UsageIdentity }

export async function handleResponses(c: Context) {
  const signal = c.req.raw.signal
  const payload = await c.req.json<ResponsesPayload>()
  const messageContent = extractMessageContentFromResponsesPayload(payload)
  // Forward session_id, thread_id, and provider-specific headers from the
  // incoming request so that upstream providers can reuse cached prompt
  // prefixes across turns within the same session. Without a stable
  // session_id, the backend treats every request as a new session and
  // prompt cache hit rate drops to near zero.
  const forwardedHeaders: Record<string, string | undefined> = {
    session_id: c.req.header("session_id") ?? c.req.header("session-id"),
    thread_id: c.req.header("thread_id") ?? c.req.header("thread-id"),
    "x-codex-turn-metadata": c.req.header("x-codex-turn-metadata"),
    "x-codex-window-id": c.req.header("x-codex-window-id"),
    "x-codex-beta-features": c.req.header("x-codex-beta-features"),
    // Responses Lite marker — forwarded so the upstream/parallel_tool_calls
    // invariant is preserved end-to-end.
    "x-openai-internal-codex-responses-lite": c.req.header(
      "x-openai-internal-codex-responses-lite",
    ),
    version: c.req.header("version"),
    originator: c.req.header("originator"),
    // xAI conversation ID for prompt cache grouping
    "x-grok-conv-id": c.req.header("x-grok-conv-id"),
    // Claude Code session ID (when responses→messages translation occurs)
    "x-claude-code-session-id": c.req.header("x-claude-code-session-id"),
    prompt_cache_key: c.req.header("prompt_cache_key"),
  }

  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: payload.model,
    endpoint: "responses",
    maxTokens:
      typeof payload.max_output_tokens === "number" ?
        payload.max_output_tokens
      : undefined,
    stream: payload.stream === true ? true : undefined,
    inferredInitiator: inferInitiatorFromResponsesPayload(payload),
    messageContent,
    sessionHeaders: forwardedHeaders,
    sessionPayload: payload,
  })

  // Dispatch all admissions through the unified failover path so the usage
  // identity always describes the target that actually completed the request.
  const executeRequest = (): Promise<ResponsesExecutionResult> =>
    dispatchResponses(payload, admission, signal, c, {
      initiator: admission.initiator,
      forwardedHeaders,
    }) as Promise<ResponsesExecutionResult>

  if (payload.stream) {
    return streamSSE(c, async (stream) => {
      const pingInterval = createSsePingInterval(stream)
      let accountId: string | undefined
      let completedResponse: ResponsesResponse | undefined
      let firstChunkTs: number | undefined
      const streamStartTs = Date.now()

      try {
        const result = await executeRequest()
        accountId = result.accountId
        applyUsageIdentity(
          c,
          result.identity ?? identityFromAdmission(admission),
        )
        c.set("model", payload.model)

        if (isNonStreaming(result.response)) {
          const elapsed = Date.now() - streamStartTs
          const usage = result.response.usage
          const completionTokens = usage?.output_tokens ?? 0
          const tps = elapsed > 0 ? completionTokens / (elapsed / 1000) : 0
          completedResponse = result.response
          recordResponsesUsage({
            c,
            accountId,
            response: completedResponse,
            tps,
            streaming: false,
          })
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

          if (!firstChunkTs) {
            firstChunkTs = Date.now()
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
          const elapsed = Date.now() - streamStartTs
          const completionTokens = completedResponse.usage?.output_tokens ?? 0
          const tps = elapsed > 0 ? completionTokens / (elapsed / 1000) : 0
          const ttftMs = firstChunkTs ? firstChunkTs - streamStartTs : undefined
          recordResponsesUsage({
            c,
            accountId,
            response: completedResponse,
            tps,
            streaming: true,
            ttftMs,
          })
        }
      }
    })
  }

  const nonStreamStart = Date.now()
  const result = await executeRequest()
  applyUsageIdentity(c, result.identity ?? identityFromAdmission(admission))
  c.set("model", payload.model)
  if (!isNonStreaming(result.response)) {
    throw new Error("Expected non-streaming response for non-stream request")
  }

  const elapsed = Date.now() - nonStreamStart
  const completionTokens = result.response.usage?.output_tokens ?? 0
  const tps = elapsed > 0 ? completionTokens / (elapsed / 1000) : 0
  recordResponsesUsage({
    c,
    accountId: result.accountId,
    response: result.response,
    tps,
    streaming: false,
  })
  return c.json(result.response)
}

export function isNonStreaming(
  response: AsyncIterable<CopilotStreamEventLike> | ResponsesResponse,
): response is ResponsesResponse {
  return Object.hasOwn(response, "id") && Object.hasOwn(response, "model")
}

interface RecordResponsesUsageOpts {
  c: Context
  accountId: string
  response: ResponsesResponse
  tps?: number
  streaming?: boolean
  ttftMs?: number
}

export function recordResponsesUsage(opts: RecordResponsesUsageOpts): void {
  const { c, accountId, response, tps, streaming, ttftMs } = opts
  const usage = response.usage
  const model = c.get("model")
  if (!usage || !model) {
    return
  }

  // OpenAI Responses API only reports cache reads via
  // `input_tokens_details.cached_tokens`. There is no cache-creation field
  // (that is an Anthropic-only concept).
  const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0
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
    cacheWriteTokens: 0,
    tps,
    streaming,
    ttftMs,
  })
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

  const message = extractErrorMessage(error)

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
