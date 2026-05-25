import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  prepareRequestAdmission,
  requireLegacyAdmission,
} from "~/lib/request-admission"
import { recordUsage } from "~/lib/usage"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()
    const admission = requireLegacyAdmission(
      await prepareRequestAdmission(c, {
        model: payload.model,
        endpoint: "embeddings",
      }),
    )
    const result = await createEmbeddings(payload, {
      account: admission.account,
      signal: c.req.raw.signal,
    })

    // Set accountId for logging
    c.set("accountId", result.accountId)

    const usage = result.response.usage
    recordUsage({
      c,
      accountId: result.accountId,
      model: result.response.model,
      promptTokens: usage.prompt_tokens,
      completionTokens: 0,
      totalTokens: usage.total_tokens,
    })

    return c.json(result.response)
  } catch (error) {
    return forwardError(c, error)
  }
})
