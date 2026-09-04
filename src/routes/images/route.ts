import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { MAX_MEDIA_JSON_BODY_BYTES, readJsonBody } from "~/lib/request-body"
import { recordTraceError } from "~/lib/request-log"
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
    const payload = await readJsonBody<ImageGenerationRequest>(
      c.req.raw,
      MAX_MEDIA_JSON_BODY_BYTES,
    )
    const admission = await prepareRequestAdmission(c, {
      model: payload.model,
      endpoint: "images",
    })

    const idempotencyKey = c.req.header("x-idempotency-key")
    const response = await createXaiImageGeneration(
      {
        connection: admission.connection,
        credential: admission.credential,
      },
      payload,
      c.req.raw.signal,
      idempotencyKey,
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

imageRoutes.post("/edits", async (c) => {
  try {
    const payload = await readJsonBody<ImageEditRequest>(
      c.req.raw,
      MAX_MEDIA_JSON_BODY_BYTES,
    )
    const admission = await prepareRequestAdmission(c, {
      model: payload.model,
      endpoint: "images",
    })

    const idempotencyKey = c.req.header("x-idempotency-key")
    const response = await createXaiImageEdit(
      {
        connection: admission.connection,
        credential: admission.credential,
      },
      payload,
      c.req.raw.signal,
      idempotencyKey,
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
