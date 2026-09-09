import type { Context } from "hono"

import { Hono } from "hono"

import { forwardError, HTTPError } from "~/lib/error"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { MAX_MEDIA_JSON_BODY_BYTES, readJsonBody } from "~/lib/request-body"
import { recordTraceError } from "~/lib/request-log"
import { recordUsage } from "~/lib/usage"
import {
  createCodexImageEdit,
  createCodexImageGeneration,
  parseImageEditMultipart,
  type CodexImageEditRequest,
  type CodexImageGenerationRequest,
} from "~/services/codex/create-images"
import {
  createXaiImageEdit,
  createXaiImageGeneration,
  type ImageEditRequest,
  type ImageGenerationRequest,
} from "~/services/xai/create-images"

export const imageRoutes = new Hono()

function collectImageForwardedHeaders(
  c: Context,
): Record<string, string | undefined> {
  return {
    session_id: c.req.header("session_id") ?? c.req.header("session-id"),
    thread_id: c.req.header("thread_id") ?? c.req.header("thread-id"),
    "x-client-request-id": c.req.header("x-client-request-id"),
    prompt_cache_key: c.req.header("prompt_cache_key"),
  }
}

imageRoutes.post("/generations", async (c) => {
  try {
    const payload = await readJsonBody<
      ImageGenerationRequest | CodexImageGenerationRequest
    >(c.req.raw, MAX_MEDIA_JSON_BODY_BYTES)
    const admission = await prepareRequestAdmission(c, {
      model: payload.model,
      endpoint: "images",
    })

    const idempotencyKey = c.req.header("x-idempotency-key")
    const subject = {
      connection: admission.connection,
      credential: admission.credential,
    }
    const response =
      admission.connection.protocol === "codex-native" ?
        await createCodexImageGeneration(
          subject,
          payload as CodexImageGenerationRequest,
          c.req.raw.signal,
          {
            forwardedHeaders: collectImageForwardedHeaders(c),
          },
        )
      : await createXaiImageGeneration(
          subject,
          payload as ImageGenerationRequest,
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
    const contentType = c.req.header("content-type") ?? ""
    const isMultipart = contentType
      .split(";")[0]
      ?.trim()
      .toLowerCase()
      .endsWith("multipart/form-data")
    // multipart（官方 form-data 传文件）与 JSON 共用一套下游：
    // 先解析成 JSON 形态，再走 codex/xAI 分流。
    const payload =
      isMultipart ?
        await parseImageEditMultipart(c.req.raw)
      : await readJsonBody<ImageEditRequest | CodexImageEditRequest>(
          c.req.raw,
          MAX_MEDIA_JSON_BODY_BYTES,
        )
    const editModel = typeof payload.model === "string" ? payload.model : ""
    if (!editModel.trim()) {
      throw new HTTPError(
        "Image edit request is missing model",
        new Response("Bad Request", { status: 400 }),
      )
    }
    const admission = await prepareRequestAdmission(c, {
      model: editModel,
      endpoint: "images",
    })

    const idempotencyKey = c.req.header("x-idempotency-key")
    const subject = {
      connection: admission.connection,
      credential: admission.credential,
    }
    const response =
      admission.connection.protocol === "codex-native" ?
        await createCodexImageEdit(
          subject,
          payload as CodexImageEditRequest,
          c.req.raw.signal,
          {
            forwardedHeaders: collectImageForwardedHeaders(c),
          },
        )
      : await createXaiImageEdit(
          subject,
          payload as ImageEditRequest,
          c.req.raw.signal,
          idempotencyKey,
        )

    c.set("accountId", admission.connection.id)
    recordUsage({
      c,
      accountId: admission.connection.id,
      model: editModel,
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
