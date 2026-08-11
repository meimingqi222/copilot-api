import type { Context } from "hono"

import type { Account } from "~/lib/accounts"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic"

import { HTTPError } from "~/lib/error"
import { buildAnthropicUpstreamError } from "~/lib/error-builder"
import { logger } from "~/lib/logger"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import {
  beginStreamLog,
  finishRequestLog,
  markStreamTerminal,
  recordTraceError,
} from "~/lib/request-log"
import { handleSseStream, writeSseEvent } from "~/lib/sse"
import { createMessages } from "~/services/copilot/create-messages"
import { isDirectAnthropicResponse } from "~/services/protocols/anthropic"

import { handleDirectStreamingResponse } from "./connection-handler"
import { recordAnthropicUsage } from "./usage-recorder"

interface HandleMessagesApiOpts {
  c: Context
  anthropicPayload: AnthropicMessagesPayload
  signal: AbortSignal
  account: Account
  initiator: "agent" | "user" | undefined
  anthropicBeta: string | undefined
  anthropicVersion: string | undefined
  forwardedHeaders?: Record<string, string | undefined>
}

export async function handleMessagesApi(opts: HandleMessagesApiOpts) {
  const {
    c,
    anthropicPayload,
    signal,
    account,
    initiator,
    anthropicBeta,
    anthropicVersion,
    forwardedHeaders,
  } = opts
  // Merge forwarded headers — forwardedHeaders already contains
  // anthropic-beta/anthropic-version from the handler, so just use it
  // directly and fill in any missing fields.
  const mergedForwardedHeaders: Record<string, string | undefined> = {
    "anthropic-version": anthropicVersion,
    ...forwardedHeaders,
  }
  // Only set anthropic-beta if not already in forwardedHeaders (avoid
  // undefined overwriting a valid value from the spread).
  if (anthropicBeta && !mergedForwardedHeaders["anthropic-beta"]) {
    mergedForwardedHeaders["anthropic-beta"] = anthropicBeta
  }
  if (!anthropicPayload.stream) {
    const nonStreamStart = Date.now()
    const result = await createMessages(anthropicPayload, {
      account,
      signal,
      initiatorOverride: initiator,
      forwardedHeaders: mergedForwardedHeaders,
      c,
    })

    c.set("accountId", result.accountId)
    c.set("model", anthropicPayload.model)

    if (isDirectAnthropicResponse(result.response)) {
      const elapsed = Date.now() - nonStreamStart
      const tps =
        elapsed > 0 ? result.response.usage.output_tokens / (elapsed / 1000) : 0
      recordAnthropicUsage(c, result.accountId, result.response, tps)
      return c.json(result.response)
    }
  }

  beginStreamLog(c)
  return handleSseStream(
    c,
    async (stream, sseSignal) => {
      const streamStartTs = Date.now()
      try {
        const result = await createMessages(anthropicPayload, {
          account,
          signal: sseSignal,
          initiatorOverride: initiator,
          forwardedHeaders: mergedForwardedHeaders,
          c,
        })

        c.set("accountId", result.accountId)
        c.set("model", anthropicPayload.model)

        if (isDirectAnthropicResponse(result.response)) {
          const elapsed = Date.now() - streamStartTs
          const tps =
            elapsed > 0 ?
              result.response.usage.output_tokens / (elapsed / 1000)
            : 0
          recordAnthropicUsage(c, result.accountId, result.response, tps)
          markStreamTerminal(c, "message_stop", "success", true)
          return
        }

        await handleDirectStreamingResponse({
          stream,
          response: result.response,
          clientSignal: sseSignal,
          c,
          accountId: result.accountId,
          skipPing: true,
          streamStartTs,
        })
      } catch (error) {
        recordTraceError(c, error)
        const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
        if (knownError) {
          const errPayload = {
            type: "error",
            error: {
              type: knownError.type,
              message: knownError.message,
            },
          }
          await writeSseEvent(
            stream,
            JSON.stringify(errPayload),
            errPayload.type,
          )
          return
        }
        if (error instanceof HTTPError) {
          logger.error(
            "Messages API upstream error",
            error.response.status,
            error.responseBody,
          )
          const errPayload = buildAnthropicUpstreamError(error)
          await writeSseEvent(
            stream,
            JSON.stringify(errPayload),
            errPayload.type,
          )
          return
        }
        throw error
      }
    },
    { onFinally: () => finishRequestLog(c) },
  )
}
