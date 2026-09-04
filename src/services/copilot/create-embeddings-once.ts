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
import { parseModelReference } from "~/lib/legacy-accounts"
import { state } from "~/lib/state"
import { copilotTokenFromCredential } from "~/services/copilot/token-refresh"

export async function createCopilotEmbeddingsOnce(
  { credential }: { connection: ProviderConnection; credential: ApiCredential },
  payload: EmbeddingRequest,
  signal?: AbortSignal,
): Promise<EmbeddingResponse> {
  const token = copilotTokenFromCredential(credential)
  if (!token) {
    throw new Error("Copilot token not found")
  }

  const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
    method: "POST",
    headers: copilotHeadersForToken(token),
    body: JSON.stringify({
      ...payload,
      model: parseModelReference(payload.model).nativeModelId,
    }),
    signal,
  })

  if (!response.ok) {
    throw new HTTPError("Failed to create embeddings", response)
  }

  return (await response.json()) as EmbeddingResponse
}
