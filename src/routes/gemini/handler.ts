import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  beginStreamLog,
  markStreamTerminal,
  markTraceFirstOutput,
} from "~/lib/request-log"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { readJsonBody } from "~/lib/request-body"
import {
  createSsePingInterval,
  writeSseComment,
  writeSseEvent,
} from "~/lib/sse"
import { isAsyncIterable } from "~/services/dispatch/concurrency"
import { dispatchGemini } from "~/services/dispatch/gemini"
import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
  GeminiStreamEvent,
  GeminiUsageMetadata,
} from "~/services/protocols/gemini"

import { parseGeminiFrame, recordGeminiUsage } from "./usage"

/**
 * Handles `POST /v1beta/models/{model}:generateContent` and
 * `:streamGenerateContent`.
 *
 * Google's wire signals streaming through the method name rather than a body
 * field, so `stream` is synthesized here before dispatch — every codec and
 * adapter downstream reads the payload field.
 */
export async function handleGenerateContent(c: Context) {
  const signal = c.req.raw.signal
  const target = parseModelAction(c.req.path)
  if (!target) {
    throw new HTTPError(
      "Expected /v1beta/models/{model}:generateContent or :streamGenerateContent",
      new Response(null, { status: 404 }),
    )
  }
  const { model, streaming } = target
  const payload = await readJsonBody<GeminiGenerateContentRequest>(c.req.raw)
  const effectivePayload: GeminiGenerateContentRequest & { model: string } = {
    ...payload,
    model,
    stream: streaming,
  }

  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model,
    endpoint: "gemini",
    stream: streaming ? true : undefined,
    messageContent: extractMessageContent(effectivePayload),
    sessionPayload: effectivePayload,
  })

  if (logger.level >= 4) {
    logger.debug("Gemini request payload summary:", {
      model,
      contentCount: effectivePayload.contents.length,
      toolCount: effectivePayload.tools?.length ?? 0,
      stream: streaming,
    })
  }

  // Dispatch before the SSE response exists so pre-first-chunk failures
  // return a real HTTP status with Retry-After instead of `200 + error frame`.
  const dispatchStart = Date.now()
  const result = await dispatchGemini(effectivePayload, admission, signal, c)

  if (!streaming) {
    if (isAsyncIterable(result.response)) {
      // The upstream streamed although the client asked for one response.
      throw new Error("Upstream streamed a non-streaming Gemini request")
    }
    const response = result.response as GeminiGenerateContentResponse
    recordGeminiUsage({
      c,
      identity: result.identity,
      usage: response.usageMetadata,
      streaming: false,
    })
    return c.json(response)
  }

  beginStreamLog(c)
  return streamSSE(c, async (stream) => {
    await writeSseComment(stream)
    const pingInterval = createSsePingInterval(stream)
    let outputObserved = false
    try {
      if (!isAsyncIterable<GeminiStreamEvent>(result.response)) {
        const response = result.response as GeminiGenerateContentResponse
        recordGeminiUsage({
          c,
          identity: result.identity,
          usage: response.usageMetadata,
          streaming: false,
          tps: 0,
        })
        await writeSseEvent(stream, JSON.stringify(response))
        markStreamTerminal(c, "candidates", "success", true)
        return
      }
      let usageMetadata: GeminiUsageMetadata | undefined
      let firstChunkTs: number | undefined
      for await (const event of result.response) {
        if (!event.data) continue
        const frame = parseGeminiFrame(event.data)
        if (frame?.usageMetadata) usageMetadata = frame.usageMetadata
        if (frame?.hasContent) {
          outputObserved = true
          if (firstChunkTs === undefined) {
            firstChunkTs = Date.now()
            markTraceFirstOutput(c, firstChunkTs - dispatchStart)
          }
        }
        await writeSseEvent(stream, event.data, event.event)
        if (frame?.finishReason) {
          markStreamTerminal(c, "candidates", "success", outputObserved)
        }
      }
      const elapsed = Date.now() - dispatchStart
      recordGeminiUsage({
        c,
        identity: result.identity,
        usage: usageMetadata,
        streaming: true,
        ttftMs:
          firstChunkTs !== undefined ? firstChunkTs - dispatchStart : undefined,
        tps:
          elapsed > 0 ?
            (usageMetadata?.candidatesTokenCount ?? 0) / (elapsed / 1000)
          : 0,
      })
    } finally {
      clearInterval(pingInterval)
    }
  })
}

/**
 * Splits `.../models/{model}:{action}` into its parts. Model ids may contain
 * slashes (`models/tunedModels/...`), so only the final segment is parsed.
 */
function parseModelAction(
  path: string,
): { model: string; streaming: boolean } | undefined {
  const marker = "/models/"
  const tail = path.slice(path.lastIndexOf(marker) + marker.length)
  const separator = tail.lastIndexOf(":")
  if (separator <= 0) return undefined
  const model = decodeURIComponent(tail.slice(0, separator))
  const action = tail.slice(separator + 1)
  if (action !== "generateContent" && action !== "streamGenerateContent") {
    return undefined
  }
  return { model, streaming: action === "streamGenerateContent" }
}

function extractMessageContent(
  payload: GeminiGenerateContentRequest,
): string | undefined {
  const parts: Array<string> = []
  for (const content of payload.contents)
    for (const part of content.parts) if (part.text) parts.push(part.text)
  return parts.length > 0 ? parts.join("\n") : undefined
}
