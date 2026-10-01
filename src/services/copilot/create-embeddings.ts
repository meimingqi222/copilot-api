import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import {
  canonicalModelId,
  parseModelReference,
} from "~/lib/route-target/model-reference"
import { accountManagedModelPrefix } from "~/lib/provider-connections"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"
import { buildDirectAdapterTarget } from "~/services/providers/adapter-target"

import type {
  EmbeddingRequest,
  EmbeddingResponse,
} from "~/services/protocols/chat/types"

export {
  type EmbeddingRequest,
  type EmbeddingResponse,
} from "~/services/protocols/chat/types"

interface CreateEmbeddingsOptions {
  connection: ProviderConnection
  credential: ApiCredential
  signal?: AbortSignal
}

export const createEmbeddings = async (
  payload: EmbeddingRequest,
  options: CreateEmbeddingsOptions,
): Promise<{
  accountId: string
  response: EmbeddingResponse
}> => {
  const routedPayload = {
    ...payload,
    model: canonicalModelId(payload.model),
  }

  const { connection, credential } = options
  initializeProtocolAdapters()
  const adapter = getProtocolAdapter(connection.protocol)
  if (!adapter?.createEmbeddings) {
    throw new Error(
      `Protocol "${connection.protocol}" does not support embeddings`,
    )
  }

  const nativeModelId = parseModelReference(
    routedPayload.model,
    accountManagedModelPrefix(connection),
  ).nativeModelId
  const target = buildDirectAdapterTarget({
    connection,
    credential,
    payloadModel: routedPayload.model,
    nativeModelId,
    endpoint: "embeddings",
  })

  const result = await adapter.createEmbeddings({
    target,
    connection,
    credential,
    payload: routedPayload,
    signal: options.signal,
  })

  return {
    accountId: connection.id,
    response: result.response,
  }
}
