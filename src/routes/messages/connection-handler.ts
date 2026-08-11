import type { Context } from "hono"

import type { RequestAdmission } from "~/lib/request-admission"

import { logger } from "~/lib/logger"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import {
  beginStreamLog,
  finishRequestLog,
  markStreamTerminal,
  patchRequestLog,
  recordTraceError,
} from "~/lib/request-log"
import { forwardSseEvent, handleSseStream, writeSseEvent } from "~/lib/sse"
import { computeStreamingTiming } from "~/lib/timing"
import { applyUsageIdentity } from "~/lib/usage"
import { dispatchMessages } from "~/services/dispatch/messages"
import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamingUsage,
  isAsyncIterable,
  isDirectAnthropicResponse,
} from "~/services/protocols/anthropic"

import type { HandleStreamingResponseOptions } from "./copilot-handler"

import { isMessagesOutputEvent } from "./logging"
import {
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
    const result = await dispatchMessages({
      payload: anthropicPayload,
      admission,
      signal,
      forwardedHeaders: forwarded,
      c,
    })
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
      }
      return c.json(result.response as unknown as AnthropicResponse)
    }
  }

  beginStreamLog(c)
  return handleSseStream(
    c,
    async (stream, sseSignal) => {
      let lastUsage: AnthropicStreamingUsage | undefined
      let resultAccountId: string | undefined
      let firstChunkTs: number | undefined
      let streamStart = 0
      let messageStop = false
      let outputObserved = false
      try {
        streamStart = Date.now()
        const result = await dispatchMessages({
          payload: anthropicPayload,
          admission,
          signal: sseSignal,
          forwardedHeaders: forwarded,
          c,
        })
        resultAccountId = result.accountId
        applyUsageIdentity(c, result.identity)
        c.set("model", anthropicPayload.model)
        patchRequestLog(c, { streaming: true })
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
            if (isOutput) firstChunkTs ??= Date.now()
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
        throw error
      } finally {
        markStreamTerminal(
          c,
          messageStop ? "message_stop" : "missing",
          messageStop ? "success" : "incomplete",
          outputObserved,
        )
        if (resultAccountId) {
          recordDirectStreamingUsage(
            c,
            resultAccountId,
            lastUsage,
            computeStreamingTiming(
              streamStart,
              firstChunkTs,
              lastUsage?.output_tokens ?? 0,
            ),
          )
        }
      }
    },
    { onFinally: () => finishRequestLog(c) },
  )
}

export async function handleDirectStreamingResponse({
  stream,
  response,
  clientSignal,
  c,
  accountId,
  streamStartTs,
}: HandleStreamingResponseOptions): Promise<void> {
  let lastUsage: AnthropicStreamingUsage | undefined

  let receivedMessageStop = false
  let firstChunkTs: number | undefined
  const streamStart = streamStartTs ?? Date.now()

  try {
    for await (const rawEvent of response) {
      if (!rawEvent.data || rawEvent.data === "[DONE]") {
        continue
      }

      const dataStr = rawEvent.data
      try {
        const parsed = JSON.parse(dataStr) as { type?: string }
        if (isMessagesOutputEvent(parsed)) firstChunkTs ??= Date.now()
      } catch {
        // Malformed frames do not count toward TTFT.
      }
      if (dataStr.includes('"usage"')) {
        lastUsage = updateLastUsage(dataStr, lastUsage)
      }
      if (dataStr.includes('"message_stop"')) {
        receivedMessageStop = receivedMessageStop || isMessageStopChunk(dataStr)
      }

      await forwardSseEvent(stream, rawEvent)
    }

    if (!receivedMessageStop) {
      logger.warn(
        "Direct streaming: upstream closed without message_stop, sending synthetic error",
      )
      const errPayload = {
        type: "error",
        error: {
          type: "api_error",
          message:
            "Upstream closed the stream unexpectedly. The model may not support images in tool results for this endpoint.",
        },
      }
      await writeSseEvent(stream, JSON.stringify(errPayload), errPayload.type)
    }
  } catch (error) {
    if (
      error instanceof DOMException
      && error.name === "AbortError"
      && clientSignal.aborted
    ) {
      return
    }
    throw error
  } finally {
    if (c) {
      markStreamTerminal(
        c,
        receivedMessageStop ? "message_stop" : "missing",
        receivedMessageStop ? "success" : "incomplete",
        Boolean(firstChunkTs),
      )
      recordDirectStreamingUsage(
        c,
        accountId,
        lastUsage,
        computeStreamingTiming(
          streamStart,
          firstChunkTs,
          lastUsage?.output_tokens ?? 0,
        ),
      )
    }
  }
}

function isMessageStopChunk(dataStr: string): boolean {
  try {
    const parsed = JSON.parse(dataStr) as { type?: string }
    return parsed.type === "message_stop"
  } catch {
    return false
  }
}
