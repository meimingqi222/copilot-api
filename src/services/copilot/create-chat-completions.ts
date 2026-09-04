import type { Context } from "hono"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { canonicalModelId, parseModelReference } from "~/lib/legacy-accounts"
import { accountManagedModelPrefix } from "~/lib/provider-connections"
import { inferInitiatorFromChatMessages } from "~/services/copilot/initiator"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"
import { buildDirectAdapterTarget } from "~/services/providers/adapter-target"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "./payload-types"

export * from "./payload-types"

interface CreateChatCompletionsOptions {
  connection: ProviderConnection
  credential: ApiCredential
  signal?: AbortSignal
  initiatorOverride?: "agent" | "user"
  forwardedHeaders?: Record<string, string | undefined>
  c?: Context
  memoryTraceId?: string
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options: CreateChatCompletionsOptions,
): Promise<{
  accountId: string
  response: ChatCompletionResponse | AsyncIterable<CopilotStreamEvent>
}> => {
  const normalizedPayload = {
    ...payload,
    model: canonicalModelId(payload.model),
  }

  const initiator =
    options.initiatorOverride
    ?? inferInitiatorFromChatMessages(normalizedPayload.messages)
  const enableVision = normalizedPayload.messages.some(
    (message) =>
      typeof message.content !== "string"
      && message.content?.some((content) => content.type === "image_url"),
  )

  const { connection, credential } = options
  initializeProtocolAdapters()
  const adapter = getProtocolAdapter(connection.protocol)
  if (!adapter?.createChatCompletions) {
    throw new Error(
      `Protocol "${connection.protocol}" does not support chat completions`,
    )
  }

  const nativeModelId = parseModelReference(
    normalizedPayload.model,
    accountManagedModelPrefix(connection),
  ).nativeModelId
  const target = buildDirectAdapterTarget({
    connection,
    credential,
    payloadModel: normalizedPayload.model,
    nativeModelId,
    endpoint: "chat",
  })

  const result = await adapter.createChatCompletions({
    target,
    connection,
    credential,
    payload: normalizedPayload,
    signal: options.signal,
    ctx: {
      initiator,
      enableVision,
      forwardedHeaders: options.forwardedHeaders,
      c: options.c,
      memoryTraceId: options.memoryTraceId,
    },
  })

  return {
    accountId: result.credentialId,
    response: result.response,
  }
}
