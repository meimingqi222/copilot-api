import { Hono } from "hono"

import { forwardError, HTTPError } from "~/lib/error"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { MAX_MEDIA_JSON_BODY_BYTES, readJsonBody } from "~/lib/request-body"
import { recordUsage } from "~/lib/usage"
import {
  createXaiVideoGeneration,
  retrieveXaiVideo,
  type VideoGenerationRequest,
} from "~/services/xai/create-videos"

export const videoRoutes = new Hono()

videoRoutes.post("/generations", async (c) => {
  try {
    const payload = await readJsonBody<VideoGenerationRequest>(
      c.req.raw,
      MAX_MEDIA_JSON_BODY_BYTES,
    )
    const admission = await prepareRequestAdmission(c, {
      model: payload.model,
      endpoint: "videos",
    })
    if (!admission.account) {
      throw new HTTPError(
        "Videos API requires an Account-based admission",
        new Response("Not Implemented", { status: 501 }),
      )
    }

    const idempotencyKey = c.req.header("x-idempotency-key")
    const response = await createXaiVideoGeneration(
      admission.account,
      payload,
      idempotencyKey,
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

videoRoutes.get("/:requestId", async (c) => {
  try {
    const requestId = c.req.param("requestId")
    // We don't know the model from the request_id alone;
    // use a wildcard model match to find any xAI account.
    // The model is returned in the response from xAI.
    const admission = await prepareRequestAdmission(c, {
      model: "grok-imagine-video",
      endpoint: "videos",
    })
    if (!admission.account) {
      throw new HTTPError(
        "Videos API requires an Account-based admission",
        new Response("Not Implemented", { status: 501 }),
      )
    }

    const response = await retrieveXaiVideo(
      admission.account,
      requestId,
      c.req.raw.signal,
    )

    c.set("accountId", admission.account.id)

    return c.json(response)
  } catch (error) {
    return forwardError(c, error)
  }
})
