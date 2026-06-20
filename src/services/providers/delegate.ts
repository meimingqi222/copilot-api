import type { Account } from "~/lib/accounts"
import type {
  ModelEndpoint,
  ProviderProtocol,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { EmbeddingRequest } from "~/services/copilot/create-embeddings"
import type { ResponsesPayload } from "~/services/copilot/responses-api"
import type { AnthropicMessagesPayload } from "~/services/protocols"

import { parseModelReference } from "~/lib/accounts"
import { DEFAULTS } from "~/lib/provider-connections"
import {
  legacyPlaceholderConn,
  legacyPlaceholderCred,
} from "~/services/dispatch/failover"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

import type {
  ProviderChatResult,
  ProviderEmbeddingsResult,
  ProviderMessagesResult,
  ProviderResponsesResult,
  RequestExecutionContext,
} from "./runtime"

export async function delegateChatToNativeAdapter(
  account: Account,
  protocol: ProviderProtocol,
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<ProviderChatResult> {
  initializeProtocolAdapters()
  const adapter = getProtocolAdapter(protocol)
  if (!adapter?.createChatCompletions) {
    throw new Error(`Protocol "${protocol}" does not support chat completions`)
  }

  const nativeModelId = parseModelReference(
    payload.model,
    account,
  ).nativeModelId
  const target: RouteTarget = {
    connectionId: account.id,
    connectionName: account.label,
    protocol,
    credentialId: account.id,
    publicModelId: payload.model,
    upstreamModelId: nativeModelId,
    endpoint: "chat",
    connectionPriority: account.priority,
    connectionWeight: DEFAULTS.CONNECTION_WEIGHT,
    credentialPriority: DEFAULTS.CREDENTIAL_PRIORITY,
    credentialWeight: DEFAULTS.CREDENTIAL_WEIGHT,
    account,
  }

  const result = await adapter.createChatCompletions(
    target,
    legacyPlaceholderConn(target),
    legacyPlaceholderCred(target),
    payload,
    signal,
    ctx,
  )

  return {
    accountId: result.credentialId,
    response: result.response,
  } as ProviderChatResult
}

export async function delegateResponsesToNativeAdapter(
  account: Account,
  protocol: ProviderProtocol,
  payload: ResponsesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<ProviderResponsesResult> {
  initializeProtocolAdapters()
  const adapter = getProtocolAdapter(protocol)
  if (!adapter?.createResponses) {
    throw new Error(`Protocol "${protocol}" does not support responses`)
  }

  const nativeModelId = parseModelReference(
    payload.model,
    account,
  ).nativeModelId
  const target: RouteTarget = {
    connectionId: account.id,
    connectionName: account.label,
    protocol,
    credentialId: account.id,
    publicModelId: payload.model,
    upstreamModelId: nativeModelId,
    endpoint: "responses" satisfies ModelEndpoint,
    connectionPriority: account.priority,
    connectionWeight: DEFAULTS.CONNECTION_WEIGHT,
    credentialPriority: DEFAULTS.CREDENTIAL_PRIORITY,
    credentialWeight: DEFAULTS.CREDENTIAL_WEIGHT,
    account,
  }

  const result = await adapter.createResponses(
    target,
    legacyPlaceholderConn(target),
    legacyPlaceholderCred(target),
    payload,
    signal,
    ctx,
  )

  return {
    accountId: result.credentialId,
    response: result.response,
  } as ProviderResponsesResult
}

export async function delegateEmbeddingsToNativeAdapter(
  account: Account,
  protocol: ProviderProtocol,
  payload: EmbeddingRequest,
  signal?: AbortSignal,
): Promise<ProviderEmbeddingsResult> {
  initializeProtocolAdapters()
  const adapter = getProtocolAdapter(protocol)
  if (!adapter?.createEmbeddings) {
    throw new Error(`Protocol "${protocol}" does not support embeddings`)
  }

  const nativeModelId = parseModelReference(
    payload.model,
    account,
  ).nativeModelId
  const target: RouteTarget = {
    connectionId: account.id,
    connectionName: account.label,
    protocol,
    credentialId: account.id,
    publicModelId: payload.model,
    upstreamModelId: nativeModelId,
    endpoint: "embeddings" satisfies ModelEndpoint,
    connectionPriority: account.priority,
    connectionWeight: DEFAULTS.CONNECTION_WEIGHT,
    credentialPriority: DEFAULTS.CREDENTIAL_PRIORITY,
    credentialWeight: DEFAULTS.CREDENTIAL_WEIGHT,
    account,
  }

  const result = await adapter.createEmbeddings(
    target,
    legacyPlaceholderConn(target),
    legacyPlaceholderCred(target),
    payload,
    signal,
  )

  return {
    accountId: result.credentialId,
    response: result.response,
  } as ProviderEmbeddingsResult
}

export async function delegateMessagesToNativeAdapter(
  account: Account,
  protocol: ProviderProtocol,
  payload: AnthropicMessagesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<ProviderMessagesResult> {
  initializeProtocolAdapters()
  const adapter = getProtocolAdapter(protocol)
  if (!adapter?.createMessages) {
    throw new Error(`Protocol "${protocol}" does not support messages`)
  }

  const nativeModelId = parseModelReference(
    payload.model,
    account,
  ).nativeModelId
  const target: RouteTarget = {
    connectionId: account.id,
    connectionName: account.label,
    protocol,
    credentialId: account.id,
    publicModelId: payload.model,
    upstreamModelId: nativeModelId,
    endpoint: "messages" satisfies ModelEndpoint,
    connectionPriority: account.priority,
    connectionWeight: DEFAULTS.CONNECTION_WEIGHT,
    credentialPriority: DEFAULTS.CREDENTIAL_PRIORITY,
    credentialWeight: DEFAULTS.CREDENTIAL_WEIGHT,
    account,
  }

  const result = await adapter.createMessages(
    target,
    legacyPlaceholderConn(target),
    legacyPlaceholderCred(target),
    payload,
    signal,
    ctx,
  )

  return {
    accountId: result.credentialId,
    response: result.response,
  } as ProviderMessagesResult
}
