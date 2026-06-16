import type { Account } from "~/lib/accounts"

import { canonicalModelId } from "~/lib/accounts"
import { getAccountProtocol } from "~/lib/request-admission"
import { delegateEmbeddingsToNativeAdapter } from "~/services/providers/delegate"

interface CreateEmbeddingsOptions {
  account: Account
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

  return delegateEmbeddingsToNativeAdapter(
    options.account,
    getAccountProtocol(options.account),
    routedPayload,
    options.signal,
  )
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
