import { Hono } from "hono"

import { forwardError, HTTPError } from "~/lib/error"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { readJsonBody } from "~/lib/request-body"
import { recordUsage } from "~/lib/usage"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const payload = await readJsonBody<EmbeddingRequest>(c.req.raw)
    const admission = await prepareRequestAdmission(c, {
      model: payload.model,
      endpoint: "embeddings",
    })
    if (!admission.account) {
      throw new HTTPError(
        "Embeddings API requires an Account-based admission",
        new Response("Not Implemented", { status: 501 }),
      )
    }
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
