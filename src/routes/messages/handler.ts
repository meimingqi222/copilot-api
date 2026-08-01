import type { Context } from "hono"

import { logger } from "~/lib/logger"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { supportsMessagesApi } from "~/services/copilot/responses-api"
import {
  extractMessageContentFromAnthropicPayload,
  type AnthropicMessagesPayload,
} from "~/services/protocols/anthropic"

import { handleAnthropicViaConnection } from "./connection-handler"
import { handleCopilotApi } from "./copilot-handler"
import { inferInitiatorFromAnthropicMessages } from "./initiator"

/** Protocols whose adapter supports native Anthropic Messages passthrough. */
const NATIVE_MESSAGES_PROTOCOLS = new Set([
  "anthropic-compatible",
  "mimo-native",
  "claude-native",
])

export async function handleCompletion(c: Context) {
  const signal = c.req.raw.signal
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const messageContent =
    extractMessageContentFromAnthropicPayload(anthropicPayload)

  const anthropicBeta = c.req.header("anthropic-beta")
  const anthropicVersion = c.req.header("anthropic-version")
  const claudeSessionId = c.req.header("x-claude-code-session-id")
  // Forward session-related headers so upstream providers can reuse cached
  // prompt prefixes across turns within the same session.
  const forwardedHeaders: Record<string, string | undefined> = {
    "anthropic-beta": anthropicBeta,
    "anthropic-version": anthropicVersion,
    "x-claude-code-session-id": claudeSessionId,
    session_id: c.req.header("session_id") ?? c.req.header("session-id"),
    "x-session-id": c.req.header("x-session-id"),
    prompt_cache_key: c.req.header("prompt_cache_key"),
  }

  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: anthropicPayload.model,
    endpoint: "messages",
    maxTokens:
      typeof anthropicPayload.max_tokens === "number" ?
        anthropicPayload.max_tokens
      : undefined,
    stream: anthropicPayload.stream === true ? true : undefined,
    inferredInitiator: inferInitiatorFromAnthropicMessages(
      anthropicPayload.messages,
      anthropicBeta,
    ),
    messageContent,
    sessionHeaders: forwardedHeaders,
    sessionPayload: anthropicPayload,
  })

  if (logger.level >= 4) {
    logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))
  }

  // Copilot's native Messages API uses the unified dispatch path so failover
  // usage is attributed to the target that actually completed the request.
  if (
    admission.account
    && admission.account.provider === "copilot"
    && supportsMessagesApi(anthropicPayload.model, admission.account)
  ) {
    return handleAnthropicViaConnection({
      c,
      anthropicPayload,
      signal,
      admission,
      anthropicBeta,
      anthropicVersion,
      forwardedHeaders,
    })
  }

  // Native Messages passthrough: if the upstream protocol supports
  // Anthropic Messages natively, pass the payload through without translation.
  if (NATIVE_MESSAGES_PROTOCOLS.has(admission.target.protocol)) {
    return handleAnthropicViaConnection({
      c,
      anthropicPayload,
      signal,
      admission,
      anthropicBeta,
      anthropicVersion,
      forwardedHeaders,
    })
  }

  // Fallback: translate Anthropic → OpenAI and dispatch as chat completions
  return handleCopilotApi({
    c,
    anthropicPayload,
    signal,
    admission,
  })
}
