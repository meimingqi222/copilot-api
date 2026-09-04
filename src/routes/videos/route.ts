import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { MAX_MEDIA_JSON_BODY_BYTES, readJsonBody } from "~/lib/request-body"
import { recordTraceError } from "~/lib/request-log"
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

    const idempotencyKey = c.req.header("x-idempotency-key")
    const response = await createXaiVideoGeneration(
      {
        connection: admission.connection,
        credential: admission.credential,
      },
      payload,
      idempotencyKey,
      c.req.raw.signal,
    )

    c.set("accountId", admission.connection.id)
    recordUsage({
      c,
      accountId: admission.connection.id,
      model: payload.model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    })

    return c.json(response)
  } catch (error) {
    recordTraceError(c, error)
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

    const response = await retrieveXaiVideo(
      {
        connection: admission.connection,
        credential: admission.credential,
      },
      requestId,
      c.req.raw.signal,
    )

    c.set("accountId", admission.connection.id)

    return c.json(response)
  } catch (error) {
    recordTraceError(c, error)
    return forwardError(c, error)
  }
})
