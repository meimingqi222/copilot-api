import { canonicalModelId, getAccountForModel } from "~/lib/accounts"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

export const createEmbeddings = async (
  payload: EmbeddingRequest,
): Promise<{
  accountId: string
  response: EmbeddingResponse
}> => {
  initializeProviderRegistry()
  const routedPayload = {
    ...payload,
    model: canonicalModelId(payload.model),
  }
  const account = getAccountForModel(routedPayload.model)
  const runtime = getProviderRuntime(account.provider)
  if (!runtime.createEmbeddings) {
    throw new Error(
      `Model "${payload.model}" does not support embeddings on provider "${account.provider}"`,
    )
  }

  return runtime.createEmbeddings(account, routedPayload)
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
