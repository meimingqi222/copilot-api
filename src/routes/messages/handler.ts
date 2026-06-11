import type { Context } from "hono"

import consola from "consola"

import { prepareRequestAdmission } from "~/lib/request-admission"
import { supportsMessagesApi } from "~/services/copilot/responses-api"

import {
  extractMessageContentFromAnthropicPayload,
  type AnthropicMessagesPayload,
} from "./anthropic-types"
import { handleAnthropicViaConnection } from "./connection-handler"
import { handleCopilotApi } from "./copilot-handler"
import { inferInitiatorFromAnthropicMessages } from "./initiator"
import { handleMessagesApi } from "./messages-api-handler"

/** Protocols whose adapter supports native Anthropic Messages passthrough. */
const NATIVE_MESSAGES_PROTOCOLS = new Set([
  "anthropic-compatible",
  "mimo-native",
])

export async function handleCompletion(c: Context) {
  const signal = c.req.raw.signal
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  const messageContent =
    extractMessageContentFromAnthropicPayload(anthropicPayload)

  const anthropicBeta = c.req.header("anthropic-beta")
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
  })

  const anthropicVersion = c.req.header("anthropic-version")
  if (consola.level >= 4) {
    consola.debug(
      "Anthropic request payload:",
      JSON.stringify(anthropicPayload),
    )
  }

  // Copilot Messages API (native Anthropic API passthrough)
  if (
    admission.kind === "account"
    && admission.account.provider === "copilot"
    && supportsMessagesApi(anthropicPayload.model, admission.account)
  ) {
    return handleMessagesApi({
      c,
      anthropicPayload,
      signal,
      account: admission.account,
      initiator: admission.initiator,
      anthropicBeta,
      anthropicVersion,
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
