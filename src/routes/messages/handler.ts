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

  // Provider Connection 路径
  if (admission.kind === "connection") {
    if (admission.connection.protocol === "anthropic-compatible") {
      return handleAnthropicViaConnection({
        c,
        anthropicPayload,
        signal,
        admission,
        anthropicBeta,
        anthropicVersion,
      })
    }
    // openai-compatible 或其它:走 Anthropic -> OpenAI 翻译链路,
    // 然后通过 dispatcher 调用对应 adapter。
    return handleCopilotApi({
      c,
      anthropicPayload,
      signal,
      admission,
    })
  }

  if (
    supportsMessagesApi(anthropicPayload.model, admission.account)
    && admission.account.provider === "copilot"
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

  return handleCopilotApi({
    c,
    anthropicPayload,
    signal,
    admission,
  })
}
