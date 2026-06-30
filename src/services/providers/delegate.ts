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

import { accountToConnection } from "~/lib/account-adapter"
import { parseModelReference } from "~/lib/accounts"
import { DEFAULTS } from "~/lib/provider-connections"
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

/**
 * 为 account-backed 路径构造虚拟 ProviderConnection/ApiCredential。
 *
 * Step B 之前用 legacyPlaceholderConn/legacyPlaceholderCred 生成最小占位对象,
 * 现在统一通过 accountToConnection 生成真实虚拟对象(包含 credential.value、
 * context、metadata 等),让 native adapter 能读取 token 与上游配置。
 */
function buildVirtualConnectionParts(account: Account): {
  connection: import("~/lib/provider-connections").ProviderConnection
  credential: import("~/lib/provider-connections").ApiCredential
} {
  const connection = accountToConnection(account)
  return { connection, credential: connection.credentials[0] }
}

function buildAccountTarget(
  account: Account,
  protocol: ProviderProtocol,
  payloadModel: string,
  nativeModelId: string,
  endpoint: ModelEndpoint,
): RouteTarget {
  return {
    connectionId: account.id,
    connectionName: account.label,
    protocol,
    credentialId: account.id,
    publicModelId: payloadModel,
    upstreamModelId: nativeModelId,
    endpoint,
    connectionPriority: account.priority,
    connectionWeight: DEFAULTS.CONNECTION_WEIGHT,
    credentialPriority: DEFAULTS.CREDENTIAL_PRIORITY,
    credentialWeight: DEFAULTS.CREDENTIAL_WEIGHT,
    account,
  }
}

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
  const target = buildAccountTarget(
    account,
    protocol,
    payload.model,
    nativeModelId,
    "chat",
  )
  const { connection, credential } = buildVirtualConnectionParts(account)

  const result = await adapter.createChatCompletions({
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
  })

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
  const target = buildAccountTarget(
    account,
    protocol,
    payload.model,
    nativeModelId,
    "responses" satisfies ModelEndpoint,
  )
  const { connection, credential } = buildVirtualConnectionParts(account)

  const result = await adapter.createResponses({
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
  })

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
  const target = buildAccountTarget(
    account,
    protocol,
    payload.model,
    nativeModelId,
    "embeddings" satisfies ModelEndpoint,
  )
  const { connection, credential } = buildVirtualConnectionParts(account)

  const result = await adapter.createEmbeddings({
    target,
    connection,
    credential,
    payload,
    signal,
  })

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
  const target = buildAccountTarget(
    account,
    protocol,
    payload.model,
    nativeModelId,
    "messages" satisfies ModelEndpoint,
  )
  const { connection, credential } = buildVirtualConnectionParts(account)

  const result = await adapter.createMessages({
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
  })

  return {
    accountId: result.credentialId,
    response: result.response,
  } as ProviderMessagesResult
}
