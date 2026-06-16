import type { Account, CopilotAccount } from "~/lib/accounts"
import type {
  EmbeddingRequest,
  EmbeddingResponse,
} from "~/services/copilot/create-embeddings"

import { getCopilotToken, parseModelReference } from "~/lib/accounts"
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export async function createCopilotEmbeddingsOnce(
  account: Account,
  payload: EmbeddingRequest,
  signal?: AbortSignal,
): Promise<EmbeddingResponse> {
  const copilotAccount = account as CopilotAccount
  if (!getCopilotToken(copilotAccount)) {
    throw new Error("Copilot token not found")
  }

  const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
    method: "POST",
    headers: copilotHeaders(copilotAccount),
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
