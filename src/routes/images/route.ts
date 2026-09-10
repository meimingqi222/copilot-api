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
  type CodexImageGenerationResponse,
} from "~/services/codex/create-images"
import {
  createXaiImageEdit,
  createXaiImageGeneration,
  type ImageEditRequest,
  type ImageGenerationRequest,
  type ImageGenerationResponse,
} from "~/services/xai/create-images"

export const imageRoutes = new Hono()

type ImageAction = "generations" | "edits"

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

/**
 * 两个图片端口共用的下游：admission → 按 connection 协议分流到 codex/xAI →
 * 记录用量 → 返回 JSON。`model` 为路由用的规范模型名，`payload` 保留原始字段。
 */
async function dispatchImageRequest(
  c: Context,
  action: ImageAction,
  payload: object,
  model: string,
): Promise<Response> {
  const admission = await prepareRequestAdmission(c, {
    model,
    endpoint: "images",
  })
  const subject = {
    connection: admission.connection,
    credential: admission.credential,
  }
  const signal = c.req.raw.signal

  let response: CodexImageGenerationResponse | ImageGenerationResponse
  if (admission.connection.protocol === "codex-native") {
    const forwardedHeaders = collectImageForwardedHeaders(c)
    response =
      action === "generations" ?
        await createCodexImageGeneration(
          subject,
          payload as CodexImageGenerationRequest,
          signal,
          { forwardedHeaders },
        )
      : await createCodexImageEdit(
          subject,
          payload as CodexImageEditRequest,
          signal,
          { forwardedHeaders },
        )
  } else {
    const idempotencyKey = c.req.header("x-idempotency-key")
    response =
      action === "generations" ?
        await createXaiImageGeneration(
          subject,
          payload as ImageGenerationRequest,
          signal,
          idempotencyKey,
        )
      : await createXaiImageEdit(
          subject,
          payload as ImageEditRequest,
          signal,
          idempotencyKey,
        )
  }

  c.set("accountId", admission.connection.id)
  recordUsage({
    c,
    accountId: admission.connection.id,
    model,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  })
  return c.json(response)
}

imageRoutes.post("/generations", async (c) => {
  try {
    const payload = await readJsonBody<
      ImageGenerationRequest | CodexImageGenerationRequest
    >(c.req.raw, MAX_MEDIA_JSON_BODY_BYTES)
    return await dispatchImageRequest(c, "generations", payload, payload.model)
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
    return await dispatchImageRequest(c, "edits", payload, editModel)
  } catch (error) {
    recordTraceError(c, error)
    return forwardError(c, error)
  }
})
