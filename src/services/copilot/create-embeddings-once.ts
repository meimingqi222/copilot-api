import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  EmbeddingRequest,
  EmbeddingResponse,
} from "~/services/copilot/create-embeddings"

import { copilotBaseUrl, copilotHeadersForToken } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import {
  performanceFetch as fetch,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"
import { parseModelReference } from "~/lib/route-target/model-reference"
import { state } from "~/lib/state"
import { copilotTokenFromCredential } from "~/services/copilot/token-refresh"
import { connectionFetchInit } from "~/services/protocols/shared"

export async function createCopilotEmbeddingsOnce(
  {
    connection,
    credential,
  }: { connection: ProviderConnection; credential: ApiCredential },
  payload: EmbeddingRequest,
  signal?: AbortSignal,
): Promise<EmbeddingResponse> {
  const token = copilotTokenFromCredential(credential)
  if (!token) {
    throw new Error("Copilot token not found")
  }

  const response = await fetch(
    `${copilotBaseUrl(state)}/embeddings`,
    connectionFetchInit(connection, {
      method: "POST",
      headers: copilotHeadersForToken(token),
      body: serializeUpstreamBody({
        ...payload,
        model: parseModelReference(payload.model).nativeModelId,
      }),
      signal,
    }),
  )

  if (!response.ok) {
    throw new HTTPError("Failed to create embeddings", response)
  }

  return (await response.json()) as EmbeddingResponse
}
