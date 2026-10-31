import type { Context } from "hono"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { readJsonBody } from "~/lib/request-body"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  decodeMessagesRequest,
  encodeChatRequest,
} from "~/services/ir/codecs/messages-chat"
import { type AnthropicMessagesPayload } from "~/services/protocols/anthropic"

import { hasClaudeCodeBeta } from "./anthropic-beta"

/** Anthropic's error-type vocabulary for an HTTP status this route can return. */
function anthropicErrorType(status: number): string {
  if (status === 400 || status === 413 || status === 422)
    return "invalid_request_error"
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found_error"
  if (status === 429) return "rate_limit_error"
  return "api_error"
}

/**
 * `/v1/messages` clients parse Anthropic's `{ type: "error", error: { … } }`
 * envelope, so this route must not let `forwardError` wrap a failure in its
 * OpenAI shape (the default for a body-less `HTTPError`).
 */
function anthropicError(message: string, status: number): HTTPError {
  const body = JSON.stringify({
    type: "error",
    error: { type: anthropicErrorType(status), message },
  })
  return new HTTPError(
    message,
    new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    body,
  )
}

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header("anthropic-beta")

    const anthropicPayload = await readJsonBody<AnthropicMessagesPayload>(
      c.req.raw,
    )

    let openAIPayload: ReturnType<typeof encodeChatRequest>
    try {
      openAIPayload = encodeChatRequest(decodeMessagesRequest(anthropicPayload))
    } catch (error) {
      // The local Messages→Chat decoder only covers payloads translation can
      // represent. Document/file blocks and a payload without a `messages`
      // array fall outside it, and counting tokens is advisory: keep the
      // historical placeholder instead of failing a request upstream can still
      // serve.
      logger.warn("Token count unavailable for this payload:", error)
      return c.json({ input_tokens: 1 })
    }

    const selectedModel = state.models?.data.find(
      (model) => model.id === anthropicPayload.model,
    )

    if (!selectedModel) {
      logger.warn("Model not found, returning default token count")
      return c.json({
        input_tokens: 1,
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    // `tokenCount.input` is already the full prompt estimate (all messages +
    // tools), including assistant history.
    let finalTokenCount = tokenCount.input
    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (hasClaudeCodeBeta(anthropicBeta)) {
        mcpToolExist = anthropicPayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist) {
        if (anthropicPayload.model.startsWith("claude")) {
          // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
          finalTokenCount += 346
        } else if (anthropicPayload.model.startsWith("grok")) {
          finalTokenCount += 480
        }
      }
    }

    if (anthropicPayload.model.startsWith("claude")) {
      finalTokenCount = Math.round(finalTokenCount * 1.15)
    } else if (anthropicPayload.model.startsWith("grok")) {
      finalTokenCount = Math.round(finalTokenCount * 1.03)
    }

    logger.info("Token count:", finalTokenCount)

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    logger.error("Error counting tokens:", error)
    if (error instanceof SyntaxError) {
      // The body itself was unparseable: answer 400 with the Anthropic error
      // envelope instead of `forwardError`'s OpenAI-shaped 500.
      throw anthropicError("Invalid JSON body", 400)
    }
    if (error instanceof HTTPError) {
      // readJsonBody rejects an oversized body with a body-less 413; keep the
      // status but shape it for this route's clients.
      throw anthropicError(error.message, error.response.status)
    }
    // Anything else is a real server-side failure; it must not be disguised as
    // a 200 count, and its body must still be an Anthropic error envelope.
    throw anthropicError("Internal server error", 500)
  }
}
