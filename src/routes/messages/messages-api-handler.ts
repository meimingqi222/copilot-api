import type { Context } from "hono"

import consola from "consola"

import type { Account } from "~/lib/accounts"

import { HTTPError } from "~/lib/error"
import { buildAnthropicUpstreamError } from "~/lib/error-builder"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import { handleSseStream, writeSseEvent } from "~/lib/sse"
import { createMessages } from "~/services/copilot/create-messages"

import type { AnthropicMessagesPayload } from "./anthropic-types"

import { isDirectAnthropicResponse } from "./anthropic-types"
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
  } = opts
  if (!anthropicPayload.stream) {
    const nonStreamStart = Date.now()
    const result = await createMessages(anthropicPayload, {
      account,
      signal,
      initiatorOverride: initiator,
      forwardedHeaders: { anthropicBeta, anthropicVersion },
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

  return handleSseStream(c, async (stream, sseSignal) => {
    const streamStartTs = Date.now()
    try {
      const result = await createMessages(anthropicPayload, {
        account,
        signal: sseSignal,
        initiatorOverride: initiator,
        forwardedHeaders: { anthropicBeta, anthropicVersion },
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
      const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
      if (knownError) {
        const errPayload = {
          type: "error",
          error: {
            type: knownError.type,
            message: knownError.message,
          },
        }
        await writeSseEvent(stream, JSON.stringify(errPayload), errPayload.type)
        return
      }
      if (error instanceof HTTPError) {
        consola.error(
          "Messages API upstream error",
          error.response.status,
          error.responseBody,
        )
        const errPayload = buildAnthropicUpstreamError(error)
        await writeSseEvent(stream, JSON.stringify(errPayload), errPayload.type)
        return
      }
      throw error
    }
  })
}
