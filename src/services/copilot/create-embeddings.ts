import { getActiveAccount } from "~/lib/accounts"
import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const createEmbeddings = async (
  payload: EmbeddingRequest,
): Promise<{
  accountId: string
  response: EmbeddingResponse
}> => {
  const account = getActiveAccount()
  if (!account.copilotToken) throw new Error("Copilot token not found")

  const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
    method: "POST",
    headers: copilotHeaders(account),
    body: JSON.stringify(payload),
  })

  if (!response.ok) throw new HTTPError("Failed to create embeddings", response)

  return {
    accountId: account.id,
    response: (await response.json()) as EmbeddingResponse,
  }
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
