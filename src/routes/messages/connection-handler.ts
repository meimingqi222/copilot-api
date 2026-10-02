import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import type { RequestAdmission } from "~/lib/request-admission"

import {
  copyRateLimitHeaders,
  HTTPError,
  setRateLimitHeaders,
} from "~/lib/error"
import {
  buildAnthropicContextWindowError,
  resolveRetryableCode,
} from "~/lib/error-builder"
import { logger } from "~/lib/logger"
import { markPerformanceDispatch } from "~/lib/request-performance"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import {
  beginStreamLog,
  finishRequestLog,
  markStreamTerminal,
  markTraceFirstOutput,
  patchRequestLog,
  recordTraceError,
} from "~/lib/request-log"
import { forwardSseEvent, handleSseStream, writeSseEvent } from "~/lib/sse"
import { computeStreamingTiming } from "~/lib/timing"
import { applyUsageIdentity, recordUsage } from "~/lib/usage"
import { isAbortError } from "~/lib/utils"
import { dispatchMessages } from "~/services/dispatch/messages"
import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamingUsage,
  isAsyncIterable,
  isDirectAnthropicResponse,
  translateErrorToAnthropicErrorEvent,
} from "~/services/protocols/anthropic"

import { isMessagesOutputEvent } from "./logging"
import {
  estimateAnthropicInputTokens,
  recordDirectStreamingUsage,
  recordAnthropicUsage,
  updateLastUsage,
} from "./usage-recorder"

interface HandleAnthropicViaConnectionOpts {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  signal: AbortSignal
  admission: RequestAdmission
  anthropicBeta: string | undefined
  anthropicVersion: string | undefined
  forwardedHeaders?: Record<string, string | undefined>
}

export async function handleAnthropicViaConnection(
  opts: HandleAnthropicViaConnectionOpts,
) {
  const {
    c,
    anthropicPayload,
    signal,
    admission,
    anthropicBeta,
    anthropicVersion,
    forwardedHeaders,
  } = opts
  // Merge forwarded headers — forwardedHeaders already contains
  // anthropic-beta/anthropic-version from the handler.
  const forwarded: Record<string, string | undefined> = {
    "anthropic-version": anthropicVersion,
    ...forwardedHeaders,
  }
  if (anthropicBeta && !forwarded["anthropic-beta"]) {
    forwarded["anthropic-beta"] = anthropicBeta
  }

  if (!anthropicPayload.stream) {
    const nonStreamStart = Date.now()
    markPerformanceDispatch(c)
    let result: Awaited<ReturnType<typeof dispatchMessages>>
    try {
      result = await dispatchMessages({
        payload: anthropicPayload,
        admission,
        signal,
        forwardedHeaders: forwarded,
        c,
      })
    } catch (error) {
      return handlePreStreamDispatchError(c, error, signal)
    }
    applyUsageIdentity(c, result.identity)
    c.set("model", anthropicPayload.model)
    patchRequestLog(c, { streaming: false })
    if (!isAsyncIterable(result.response)) {
      if (
        isDirectAnthropicResponse(
          result.response as unknown as AnthropicResponse,
        )
      ) {
        const elapsed = Date.now() - nonStreamStart
        const response = result.response as unknown as AnthropicResponse
        const tps =
          elapsed > 0 ? response.usage.output_tokens / (elapsed / 1000) : 0
        recordAnthropicUsage(c, result.accountId, response, tps)
      } else {
        // 上游返回了非 Anthropic 形状:用本地估算记一行,与其他端点兜底一致。
        const estimatedInputTokens =
          await estimateAnthropicInputTokens(anthropicPayload)
        if (estimatedInputTokens > 0) {
          recordUsage({
            c,
            accountId: result.accountId,
            model: anthropicPayload.model,
            promptTokens: estimatedInputTokens,
            completionTokens: 0,
            totalTokens: estimatedInputTokens,
            tps: 0,
            streaming: false,
            finishReason: "usage_missing",
          })
        }
      }
      return c.json(result.response as unknown as AnthropicResponse)
    }
  }

  // Phase 1: dispatch BEFORE the downstream SSE response exists (same
  // rationale as chat handleStreamingCompletion): pre-first-chunk failures
  // return a real HTTP status + Retry-After headers with an Anthropic-shaped
  // body instead of `200 + event: error`.
  let result: Awaited<ReturnType<typeof dispatchMessages>>
  const dispatchStart = Date.now()
  markPerformanceDispatch(c)
  try {
    result = await dispatchMessages({
      payload: anthropicPayload,
      admission,
      signal,
      forwardedHeaders: forwarded,
      c,
    })
  } catch (error) {
    return handlePreStreamDispatchError(c, error, signal)
  }
  applyUsageIdentity(c, result.identity)
  c.set("model", anthropicPayload.model)

  beginStreamLog(c)
  return handleSseStream(
    c,
    async (stream) => {
      let lastUsage: AnthropicStreamingUsage | undefined
      // 非流式回包早返分支已记过一行，finally 必须跳过，否则同一请求记两行。
      let usageRecorded = false
      let firstChunkTs: number | undefined
      // TTFT is measured from before the upstream dispatch (see chat
      // handleStreamingCompletion): the SSE callback opens only after
      // dispatch resolved, so a clock captured here would be near-zero.
      const streamStart = dispatchStart
      let messageStop = false
      let outputObserved = false
      try {
        if (!isAsyncIterable(result.response)) {
          if (
            isDirectAnthropicResponse(
              result.response as unknown as AnthropicResponse,
            )
          ) {
            const elapsed = Date.now() - streamStart
            const response = result.response as unknown as AnthropicResponse
            const tps =
              elapsed > 0 ? response.usage.output_tokens / (elapsed / 1000) : 0
            recordAnthropicUsage(c, result.accountId, response, tps)
            usageRecorded = true
          }
          await writeSseEvent(stream, JSON.stringify(result.response))
          markStreamTerminal(c, "message_stop", "success", true)
          return
        }
        for await (const event of result.response as AsyncIterable<{
          data?: string
          event?: string
        }>) {
          if (!event.data) continue
          lastUsage = updateLastUsage(event.data, lastUsage)
          try {
            const parsed = JSON.parse(event.data) as {
              type?: string
              delta?: unknown
              content_block?: unknown
            }
            messageStop ||= parsed.type === "message_stop"
            const isOutput = isMessagesOutputEvent(parsed)
            outputObserved ||= isOutput
            if (isOutput && firstChunkTs === undefined) {
              firstChunkTs = Date.now()
              markTraceFirstOutput(c, firstChunkTs - streamStart)
            }
          } catch {
            // Malformed provider frames are forwarded but never count as output.
          }
          await forwardSseEvent(stream, event)
        }
      } catch (error) {
        recordTraceError(c, error)
        const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
        if (knownError) {
          await writeSseEvent(
            stream,
            JSON.stringify({
              type: "error",
              error: { type: knownError.type, message: knownError.message },
            }),
            "error",
          )
          return
        }
        // Ordinary upstream errors (e.g. a 500 streamed as a 200 + error event
        // by CodeBuddy) previously fell through and killed the SSE stream with
        // no terminal event, so the client saw a silent mid-stream cutoff and
        // surfaced a non-retryable generic error. Emit a real Anthropic error
        // event carrying a numeric code so clients classify it as retryable.
        logger.warn("Streaming request failed, sending error event")
        const errEvent = translateErrorToAnthropicErrorEvent(error)
        await writeSseEvent(stream, JSON.stringify(errEvent), errEvent.type)
        return
      } finally {
        markStreamTerminal(
          c,
          messageStop ? "message_stop" : "missing",
          messageStop ? "success" : "incomplete",
          outputObserved,
        )
        if (result.accountId && !usageRecorded) {
          // 常见情况有 usage;无 usage 时才做本地估算(惰性,零开销)。
          const estimatedInputTokens =
            lastUsage ? 0 : await estimateAnthropicInputTokens(anthropicPayload)
          recordDirectStreamingUsage(
            c,
            result.accountId,
            lastUsage,
            computeStreamingTiming(
              streamStart,
              firstChunkTs,
              lastUsage?.output_tokens ?? 0,
            ),
            estimatedInputTokens,
          )
        }
      }
    },
    { onFinally: () => finishRequestLog(c) },
  )
}

/** Dispatch failure before any bytes were committed to the client (both the
 * non-streaming and pre-SSE streaming paths). Returns a real HTTP status +
 * Retry-After headers with an Anthropic-shaped body. */
function handlePreStreamDispatchError(
  c: Context,
  error: unknown,
  signal: AbortSignal,
) {
  recordTraceError(c, error)
  if (isAbortError(error) && signal.aborted) {
    return new Response(null, { status: 499 })
  }
  if (error instanceof HTTPError && isContextWindowError(error)) {
    logger.warn("Context window exceeded")
    return c.json(buildAnthropicContextWindowError(error), 400)
  }
  return respondPreStreamAnthropicError(c, error)
}

/**
 * 首包前的上游失败：SSE 尚未提交，直接返回带真实状态码的 Anthropic 错误
 * 响应，并把限流 headers 抄过去（读头的客户端据此退避；没有头的盲重试
 * 客户端至少能按状态码正确分类）。
 */
function respondPreStreamAnthropicError(c: Context, error: unknown) {
  const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
  if (knownError) {
    if (knownError.retryAfterSeconds > 0) {
      setRateLimitHeaders(c, knownError.retryAfterSeconds * 1000)
    }
    return c.json(
      {
        type: "error",
        error: { type: knownError.type, message: knownError.message },
      },
      knownError.status as ContentfulStatusCode,
    )
  }
  const errPayload = translateErrorToAnthropicErrorEvent(error)
  if (error instanceof HTTPError) {
    copyRateLimitHeaders(c, error.response.headers)
  }
  return c.json(errPayload, resolveRetryableCode(error) as ContentfulStatusCode)
}

/** Returns true when the upstream error indicates the input exceeded the model context window. */
function isContextWindowError(error: HTTPError): boolean {
  return (
    error.response.status === 400
    && error.responseBody.toLowerCase().includes("context window")
  )
}
