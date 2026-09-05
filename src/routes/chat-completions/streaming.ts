import type { Context } from "hono"

import type { RequestAdmission } from "~/lib/request-admission"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { endMemoryTrace, updateMemoryTrace } from "~/lib/memory-diagnostics"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import {
  beginStreamLog,
  finishRequestLog,
  markStreamTerminal,
  patchRequestLog,
  recordTraceError,
} from "~/lib/request-log"
import { handleSseStream, writeSseEvent } from "~/lib/sse"
import { state } from "~/lib/state"
import { computeStreamingTiming } from "~/lib/timing"
import { applyUsageIdentity, recordUsage } from "~/lib/usage"
import { isChatCompletionResponse } from "~/lib/utils"
import {
  type ChatCompletionChunk,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { dispatchChatCompletions } from "~/services/dispatch/chat-completions"

import { handleNonStreamingResponse } from "./non-streaming"
import { normalizeChunk } from "./normalize"
import { recordStreamingUsage, type UsageInfo } from "./usage"

type CopilotStream = AsyncIterable<{ data?: string }>
type CachedModel = NonNullable<typeof state.models>["data"][number]

interface HandleChatStreamingResponseOptions {
  c: Context
  response: CopilotStream
  estimatedInputTokens: number
  memoryTraceId: string
  streamStartTs?: number
}

export function handleStreamingResponse(
  options: HandleChatStreamingResponseOptions,
) {
  const { c, response, estimatedInputTokens, memoryTraceId, streamStartTs } =
    options
  logger.debug("Streaming response")
  const model = c.get("model")
  const accountId = c.get("accountId")

  // Guard: if the upstream returned a non-iterable object (e.g. an error
  // body without a `choices` field that failed isChatCompletionResponse),
  // surface it as an explicit error instead of crashing with
  // "undefined is not a function" on `for await`.
  const respAny = response as unknown as
    | AsyncIterable<unknown>
    | { [Symbol.asyncIterator]?: unknown }
    | null
    | undefined
  if (
    respAny === null
    || typeof respAny === "undefined"
    || typeof respAny[Symbol.asyncIterator] !== "function"
  ) {
    const body =
      typeof response === "object" ? JSON.stringify(response) : String(response)
    logger.error(
      `Upstream returned a non-iterable response in non-stream path: ${body.slice(0, 500)}`,
    )
    // The request consumed an upstream call and produced no stream, so it still
    // needs a usage row — otherwise this failure mode is invisible in the logs,
    // which is the symptom the guard exists to make diagnosable.
    if (model && accountId) {
      recordUsage({
        c,
        accountId,
        model,
        promptTokens: estimatedInputTokens,
        completionTokens: 0,
        totalTokens: estimatedInputTokens,
        tps: 0,
        streaming: false,
        finishReason: "upstream_error",
      })
    }
    endMemoryTrace(memoryTraceId, "error")
    // The upstream body stays in the log only. It is an arbitrary third-party
    // payload — echoing it downstream forwards whatever the upstream chose to
    // put in it (internal endpoints, credential fragments in error text) to a
    // client that cannot act on it anyway.
    return c.json(
      {
        error: {
          message:
            "Upstream returned an unexpected response format (no choices and not a stream). See server logs for details.",
          type: "upstream_response_error",
        },
      },
      502,
    )
  }

  let lastUsage: UsageInfo | undefined
  let usageRecorded = false
  let firstChunkTs: number | undefined
  let downstreamCommitted = false
  let lastFinishReason: string | undefined
  let outputObserved = false
  const streamStart = streamStartTs ?? Date.now()

  beginStreamLog(c)
  return handleSseStream(
    c,
    async (stream) => {
      let outcome = "completed"
      try {
        updateMemoryTrace(memoryTraceId, "chat_sse_open")
        for await (const rawEvent of response) {
          if (rawEvent.data === "[DONE]") {
            break
          }
          if (!rawEvent.data) {
            continue
          }

          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
          const isOutput = hasChatChunkOutput(chunk)
          outputObserved ||= isOutput
          if (isOutput && !firstChunkTs) {
            firstChunkTs = Date.now()
            updateMemoryTrace(memoryTraceId, "chat_first_chunk")
          }
          if (logger.level >= 4) {
            logger.debug("Streaming raw event:", JSON.stringify(rawEvent))
          }
          if (chunk.usage) {
            lastUsage = chunk.usage
          }
          // `choices` is typed as required but some upstreams omit it on
          // usage-only / filter chunks — same reason `normalizeChunk` guards it.

          const chunkFinishReason = chunk.choices?.[0]?.finish_reason
          if (chunkFinishReason) {
            lastFinishReason = chunkFinishReason
          }
          await writeSseEvent(stream, JSON.stringify(normalizeChunk(chunk)))
          if (!downstreamCommitted) {
            downstreamCommitted = true
            updateMemoryTrace(memoryTraceId, "chat_downstream_committed", {
              responseMode: "streaming",
            })
          }
        }
      } catch (error) {
        outcome = signalOutcome(c.req.raw.signal)
        recordTraceError(c, error)
        throw error
      } finally {
        markStreamTerminal(
          c,
          lastFinishReason ? "finish_reason" : "missing",
          lastFinishReason ? "success" : "incomplete",
          outputObserved,
        )
        if (!usageRecorded) {
          usageRecorded = recordStreamingUsage({
            c,
            accountId,
            model,
            lastUsage,
            estimatedInputTokens,
            timing: computeStreamingTiming(
              streamStart,
              firstChunkTs,
              lastUsage?.completion_tokens ?? 0,
            ),
            finishReason: lastFinishReason,
          })
        }
        endMemoryTrace(memoryTraceId, outcome)
      }
    },
    {
      onAbort: () => {
        markStreamTerminal(c, "client_abort", "cancelled", outputObserved)
        // `run`'s `finally` has already executed by the time an abort reaches
        // this handler — the exception passes through it on the way out — so
        // this is the second attempt at the same request. Without the guard an
        // upstream that reports usage on every chunk gets billed twice for any
        // stream the client disconnects from.
        if (usageRecorded) return
        usageRecorded = recordStreamingUsage({
          c,
          accountId,
          model,
          lastUsage,
          estimatedInputTokens,
          timing: computeStreamingTiming(
            streamStart,
            firstChunkTs,
            lastUsage?.completion_tokens ?? 0,
          ),
          finishReason: lastFinishReason ?? "aborted",
        })
      },
      onFinally: () => finishRequestLog(c),
    },
  )
}

interface StreamingCompletionOptions {
  payload: ChatCompletionsPayload
  admission: RequestAdmission
  signal: AbortSignal | undefined
  selectedModel: CachedModel | undefined
  estimatedInputTokens: number
  memoryTraceId: string
}

export function handleStreamingCompletion(
  c: Context,
  options: StreamingCompletionOptions,
) {
  let lastUsage: UsageInfo | undefined
  let usageRecorded = false
  let accountId: string | undefined
  let firstChunkTs: number | undefined
  let downstreamCommitted = false
  let lastFinishReason: string | undefined
  let outputObserved = false
  let streamStart = 0
  beginStreamLog(c)
  return handleSseStream(
    c,
    async (stream) => {
      const { payload, admission, signal, estimatedInputTokens } = options
      const model = payload.model
      let outcome = "completed"

      try {
        updateMemoryTrace(options.memoryTraceId, "chat_sse_open")
        const dispatchStart = Date.now()
        updateMemoryTrace(options.memoryTraceId, "chat_dispatch_start")
        const result = await dispatchChatCompletions(
          payload,
          admission,
          signal,
          c,
          {
            forwardedHeaders: extractChatForwardedHeaders(c),
            memoryTraceId: options.memoryTraceId,
          },
        )
        updateMemoryTrace(
          options.memoryTraceId,
          "chat_provider_response_open",
          {
            provider: result.identity.provider,
            streaming: !isChatCompletionResponse(result.response),
          },
        )
        accountId = result.accountId
        applyUsageIdentity(c, result.identity)

        c.set("accountId", accountId)
        c.set("model", model)
        patchRequestLog(c, { streaming: true })

        if (isChatCompletionResponse(result.response)) {
          lastFinishReason =
            result.response.choices[0]?.finish_reason ?? undefined
          outputObserved = Boolean(result.response.choices[0]?.message)
          const elapsed = Date.now() - dispatchStart
          handleNonStreamingResponse(
            c,
            result.response,
            estimatedInputTokens,
            elapsed,
          )
          await writeSseEvent(stream, JSON.stringify(result.response))
          usageRecorded = true
          updateMemoryTrace(
            options.memoryTraceId,
            "chat_downstream_committed",
            {
              responseMode: "non_streaming",
            },
          )
          return
        }

        streamStart = dispatchStart
        for await (const rawEvent of result.response) {
          if (rawEvent.data === "[DONE]") {
            break
          }
          if (!rawEvent.data) {
            continue
          }

          const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
          const isOutput = hasChatChunkOutput(chunk)
          outputObserved ||= isOutput
          if (isOutput && !firstChunkTs) {
            firstChunkTs = Date.now()
            updateMemoryTrace(options.memoryTraceId, "chat_first_chunk")
          }
          if (logger.level >= 4) {
            logger.debug("Streaming raw event:", JSON.stringify(rawEvent))
          }
          if (chunk.usage) {
            lastUsage = chunk.usage
          }
          // `choices` is typed as required but some upstreams omit it on
          // usage-only / filter chunks — same reason `normalizeChunk` guards it.

          const chunkFinishReason = chunk.choices?.[0]?.finish_reason
          if (chunkFinishReason) {
            lastFinishReason = chunkFinishReason
          }
          await writeSseEvent(stream, JSON.stringify(normalizeChunk(chunk)))
          if (!downstreamCommitted) {
            downstreamCommitted = true
            updateMemoryTrace(
              options.memoryTraceId,
              "chat_downstream_committed",
              { responseMode: "streaming" },
            )
          }
        }
      } catch (error) {
        outcome = signalOutcome(signal)
        recordTraceError(c, error)
        logger.error("Streaming error:", error)
        const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
        if (knownError?.status === 499) {
          return
        }
        const errorMessage =
          knownError?.message
          ?? (error instanceof Error ? error.message : "Internal server error")
        const errorType =
          knownError?.type
          ?? (error instanceof HTTPError && error.response.status === 429 ?
            "rate_limit_error"
          : "error")
        await writeSseEvent(
          stream,
          JSON.stringify({
            error: {
              message: errorMessage,
              type: errorType,
            },
          }),
        )
        throw error
      } finally {
        markStreamTerminal(
          c,
          lastFinishReason ? "finish_reason" : "missing",
          lastFinishReason ? "success" : "incomplete",
          outputObserved,
        )
        if (!usageRecorded) {
          usageRecorded = recordStreamingUsage({
            c,
            accountId,
            model,
            lastUsage,
            estimatedInputTokens,
            timing: computeStreamingTiming(
              streamStart,
              firstChunkTs,
              lastUsage?.completion_tokens ?? 0,
            ),
            finishReason: lastFinishReason,
          })
        }
        endMemoryTrace(options.memoryTraceId, outcome)
      }
    },
    {
      onAbort: () => {
        markStreamTerminal(c, "client_abort", "cancelled", outputObserved)
        // `run`'s `finally` has already executed by the time an abort reaches
        // this handler — the exception passes through it on the way out — so
        // this is the second attempt at the same request. Without the guard an
        // upstream that reports usage on every chunk gets billed twice for any
        // stream the client disconnects from.
        if (usageRecorded) return
        usageRecorded = recordStreamingUsage({
          c,
          accountId,
          model: options.payload.model,
          lastUsage,
          estimatedInputTokens: options.estimatedInputTokens,
          timing: computeStreamingTiming(
            streamStart,
            firstChunkTs,
            lastUsage?.completion_tokens ?? 0,
          ),
          finishReason: lastFinishReason ?? "aborted",
        })
      },
      onFinally: () => finishRequestLog(c),
    },
  )
}

/**
 * Extracts session-related headers from the incoming request for forwarding
 * to upstream providers. Different providers use different session header
 * conventions:
 * - Antigravity/Gemini: `session_id`, `x-antigravity-session-id`
 * - Windsurf: `x-windsurf-session-id`, `session_id`
 * - xAI: `x-grok-conv-id`
 * - Claude (via chat→messages translation): `x-claude-code-session-id`
 */
export function extractChatForwardedHeaders(
  c: Context,
): Record<string, string | undefined> {
  return {
    session_id: c.req.header("session_id") ?? c.req.header("session-id"),
    "x-antigravity-session-id": c.req.header("x-antigravity-session-id"),
    "x-windsurf-session-id": c.req.header("x-windsurf-session-id"),
    "x-grok-conv-id": c.req.header("x-grok-conv-id"),
    "x-claude-code-session-id": c.req.header("x-claude-code-session-id"),
    prompt_cache_key: c.req.header("prompt_cache_key"),
  }
}

function signalOutcome(signal: AbortSignal | undefined): string {
  return signal?.aborted ? "aborted" : "error"
}

export function hasChatChunkOutput(chunk: ChatCompletionChunk): boolean {
  const delta = chunk.choices[0]?.delta as Record<string, unknown> | undefined
  if (!delta) return false
  return (
    hasNonEmptyChatValue(delta["content"])
    || hasNonEmptyChatValue(delta["reasoning"])
    || hasNonEmptyChatValue(delta["reasoning_content"])
    || hasNonEmptyChatValue(delta["reasoning_text"])
    || hasNonEmptyChatValue(delta["refusal"])
    || hasToolCallOutput(delta["tool_calls"])
    || hasFunctionCallOutput(delta["function_call"])
  )
}

function hasNonEmptyChatValue(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0
  if (!Array.isArray(value)) return false
  return value.some((part) => {
    if (!part || typeof part !== "object") return false
    const record = part as Record<string, unknown>
    return (
      hasNonEmptyChatValue(record.text) || hasNonEmptyChatValue(record.content)
    )
  })
}

function hasToolCallOutput(value: unknown): boolean {
  return (
    Array.isArray(value) && value.some((call) => hasFunctionCallOutput(call))
  )
}

function hasFunctionCallOutput(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const call = value as Record<string, unknown>
  const fn =
    call.function && typeof call.function === "object" ?
      (call.function as Record<string, unknown>)
    : call
  return (
    hasNonEmptyChatValue(call.id)
    || hasNonEmptyChatValue(fn.name)
    || hasNonEmptyChatValue(fn.arguments)
  )
}
