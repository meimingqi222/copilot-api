import type { Context } from "hono"

import { logger } from "~/lib/logger"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { readJsonBody } from "~/lib/request-body"
import {
  parseThinkingModel,
  thinkingConfigToAnthropic,
  thinkingConfigToReasoningEffort,
} from "~/lib/thinking"
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
  const anthropicPayload = await readJsonBody<AnthropicMessagesPayload>(
    c.req.raw,
  )
  const parsedThinkingModel = parseThinkingModel(anthropicPayload.model)
  const effectivePayload: AnthropicMessagesPayload =
    parsedThinkingModel.config ?
      {
        ...anthropicPayload,
        model: parsedThinkingModel.model,
        ...thinkingConfigToAnthropic(parsedThinkingModel.config),
        reasoning_effort: thinkingConfigToReasoningEffort(
          parsedThinkingModel.config,
        ),
      }
    : anthropicPayload
  const messageContent =
    extractMessageContentFromAnthropicPayload(effectivePayload)

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
    model: effectivePayload.model,
    endpoint: "messages",
    maxTokens:
      typeof effectivePayload.max_tokens === "number" ?
        effectivePayload.max_tokens
      : undefined,
    stream: effectivePayload.stream === true ? true : undefined,
    inferredInitiator: inferInitiatorFromAnthropicMessages(
      effectivePayload.messages,
      anthropicBeta,
    ),
    messageContent,
    sessionHeaders: forwardedHeaders,
    sessionPayload: effectivePayload,
  })

  if (logger.level >= 4) {
    logger.debug("Anthropic request payload summary:", {
      model: effectivePayload.model,
      messageCount: effectivePayload.messages.length,
      toolCount: effectivePayload.tools?.length ?? 0,
      stream: effectivePayload.stream === true,
    })
  }

  // Copilot's native Messages API uses the unified dispatch path so failover
  // usage is attributed to the target that actually completed the request.
  if (
    admission.account
    && admission.account.provider === "copilot"
    && supportsMessagesApi(effectivePayload.model, admission.account)
  ) {
    return handleAnthropicViaConnection({
      c,
      anthropicPayload: effectivePayload,
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
      anthropicPayload: effectivePayload,
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
    anthropicPayload: effectivePayload,
    signal,
    admission,
    forwardedHeaders,
  })
}
