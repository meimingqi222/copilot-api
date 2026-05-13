import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  prepareRequestAdmission,
  requireLegacyAdmission,
} from "~/lib/request-admission"
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
    })

    // Set accountId for logging
    c.set("accountId" as never, result.accountId)

    return c.json(result.response)
  } catch (error) {
    return forwardError(c, error)
  }
})
