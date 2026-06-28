import { Hono } from "hono"

import { forwardError, HTTPError } from "~/lib/error"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { recordUsage } from "~/lib/usage"
import {
  createXaiImageEdit,
  createXaiImageGeneration,
  type ImageEditRequest,
  type ImageGenerationRequest,
} from "~/services/xai/create-images"

export const imageRoutes = new Hono()

imageRoutes.post("/generations", async (c) => {
  try {
    const payload = await c.req.json<ImageGenerationRequest>()
    const admission = await prepareRequestAdmission(c, {
      model: payload.model,
      endpoint: "images",
    })
    if (!admission.account) {
      throw new HTTPError(
        "Images API requires an Account-based admission",
        new Response("Not Implemented", { status: 501 }),
      )
    }

    const response = await createXaiImageGeneration(
      admission.account,
      payload,
      c.req.raw.signal,
    )

    c.set("accountId", admission.account.id)
    recordUsage({
      c,
      accountId: admission.account.id,
      model: payload.model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    })

    return c.json(response)
  } catch (error) {
    return forwardError(c, error)
  }
})

imageRoutes.post("/edits", async (c) => {
  try {
    const payload = await c.req.json<ImageEditRequest>()
    const admission = await prepareRequestAdmission(c, {
      model: payload.model,
      endpoint: "images",
    })
    if (!admission.account) {
      throw new HTTPError(
        "Images API requires an Account-based admission",
        new Response("Not Implemented", { status: 501 }),
      )
    }

    const response = await createXaiImageEdit(
      admission.account,
      payload,
      c.req.raw.signal,
    )

    c.set("accountId", admission.account.id)
    recordUsage({
      c,
      accountId: admission.account.id,
      model: payload.model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    })

    return c.json(response)
  } catch (error) {
    return forwardError(c, error)
  }
})
