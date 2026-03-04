import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()
    const result = await createEmbeddings(payload)

    // Set accountId for logging
    c.set("accountId" as never, result.accountId)

    return c.json(result.response)
  } catch (error) {
    return forwardError(c, error)
  }
})
