import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { ResponsesResponse } from "~/services/copilot/responses-api"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
} from "~/services/copilot/responses-api-types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { HTTPError } from "~/lib/error"
import { canonicalNativeModelId } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import {
  getCredentialContextString,
  getConnectionSettings,
} from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { sanitizeCodexInput } from "~/services/codex/sanitize-input"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import { collectResponsesFromEventStream } from "~/services/responses/sse-collector"

import { buildCodexHeaders } from "./headers"
import {
  resolveCodexExtraHeaders,
  resolveCodexSessionHeaders,
} from "./session-headers"
import { convertSystemRoleToDeveloper } from "./upstream-body"

/**
 * Codex 上游 `/v1/images/generations` / `/v1/images/edits`（OpenAI 图片端口）。
 *
 * 对齐 CPA `codex_openai_images.go` 的双路径：
 * - 请求 gpt-image-1.5 / gpt-image-2（直出模型）→ 直接调上游
 *   `/images/generations` 或 `/images/edits`，body 透传（仅规范 model/stream）。
 * - 其他模型 → 翻译成 `/responses` 调用：塞一个
 *   `{"type":"image_generation"}` tool + `tool_choice`，等流里的
 *   `image_generation_call` 输出项再拼回 OpenAI images 响应格式。
 */

export interface CodexImageGenerationRequest {
  model: string
  prompt: string
  n?: number
  size?: string
  response_format?: "b64_json" | "url"
  quality?: string
  background?: string
  output_format?: string
  moderation?: string
  output_compression?: number
  partial_images?: number
  user?: string
  [key: string]: unknown
}

export interface CodexImageEditRequest extends CodexImageGenerationRequest {
  image?: { type?: string; image_url?: string; url?: string } | string
  images?: Array<{ type?: string; image_url?: string; url?: string } | string>
  input_fidelity?: string
  mask?: { image_url?: string } | string
}

export interface CodexImageGenerationResponse {
  created: number
  data: Array<{
    b64_json?: string
    url?: string
    revised_prompt?: string
  }>
  background?: string
  output_format?: string
  quality?: string
  size?: string
  usage?: unknown
}

interface ImageCallResult {
  result: string
  revisedPrompt: string
  outputFormat: string
  size: string
  background: string
  quality: string
}

const GPT_IMAGE_15_MODEL = "gpt-image-1.5"
const DEFAULT_IMAGE_TOOL_MODEL = "gpt-image-2"
const IMAGE_TOOL_BASE_MODEL = "gpt-5.4-mini"

function normalizeImageModel(model: string): string {
  let name = model.trim()
  const slash = name.lastIndexOf("/")
  if (slash !== -1 && slash < name.length - 1) {
    name = name.slice(slash + 1).trim()
  }
  return name.toLowerCase()
}

function isDirectImageModel(model: string): boolean {
  const base = normalizeImageModel(model)
  return base === GPT_IMAGE_15_MODEL || base === DEFAULT_IMAGE_TOOL_MODEL
}

function resolveImageToolModel(
  requestModel: string,
  routeModel: string,
): string {
  const requested = requestModel.trim() || routeModel.trim()
  if (requested) return requested
  return DEFAULT_IMAGE_TOOL_MODEL
}

function normalizeResponseFormat(format: unknown): "b64_json" | "url" {
  if (typeof format === "string" && format.trim().toLowerCase() === "url") {
    return "url"
  }
  return "b64_json"
}

function mimeTypeFromOutputFormat(outputFormat: string): string {
  switch (outputFormat.trim().toLowerCase()) {
    case "jpg":
    case "jpeg": {
      return "image/jpeg"
    }
    case "webp": {
      return "image/webp"
    }
    default: {
      return "image/png"
    }
  }
}

function trimToString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * multipart/form-data 的 `/edits` 解析（对齐 CPA
 * `codexRewriteOpenAIImageEditMultipartToJSON`）：文本字段按原样收录
 * （n/output_compression/partial_images 转数字），`image`/`image[]` 文件
 * 转 data URL 并入 `images`，`mask` 文件转 `mask.image_url`。
 */
export async function parseImageEditMultipart(
  request: Request,
): Promise<Record<string, unknown>> {
  const form = await request.formData()
  const out: Record<string, unknown> = {}

  const model = trimToString(form.get("model"))
  if (model) out.model = model

  const numericFields = new Set(["n", "output_compression", "partial_images"])
  for (const key of form.keys()) {
    if (
      key === "model"
      || key === "image"
      || key === "image[]"
      || key === "mask"
    ) {
      continue
    }
    const values = form
      .getAll(key)
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
    if (values.length === 0) continue
    if (values.length === 1 && !numericFields.has(key)) {
      const single = values[0] as string
      if (key === "mask[image_url]") {
        out.mask = { image_url: single }
      } else {
        out[key] = single
      }
      continue
    }
    out[key] =
      numericFields.has(key) ?
        values.map(Number).filter((n) => Number.isFinite(n))
      : values
  }

  const fileToDataUrl = async (file: {
    arrayBuffer(): Promise<ArrayBuffer>
    type?: string
  }): Promise<string> => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const mediaType =
      (typeof file.type === "string" && file.type.trim())
      || detectImageMediaType(bytes)
      || "image/png"
    return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`
  }

  const imageFiles: Array<{
    arrayBuffer(): Promise<ArrayBuffer>
    type?: string
    size: number
  }> = []
  for (const key of ["image", "image[]"]) {
    for (const value of form.getAll(key)) {
      if (typeof value === "string") continue
      const file = value as unknown as {
        arrayBuffer(): Promise<ArrayBuffer>
        type?: string
        size: number
      }
      if (file.size > 0) imageFiles.push(file)
    }
  }
  if (imageFiles.length > 0) {
    const images: Array<{ image_url: string }> = []
    for (const file of imageFiles) {
      images.push({ image_url: await fileToDataUrl(file) })
    }
    out.images = images
  }

  const maskRaw = form.get("mask")
  if (typeof maskRaw !== "string" && maskRaw) {
    const maskFile = maskRaw as unknown as {
      arrayBuffer(): Promise<ArrayBuffer>
      type?: string
      size: number
    }
    if (maskFile.size > 0) {
      out.mask = { image_url: await fileToDataUrl(maskFile) }
    }
  }

  return out
}

function detectImageMediaType(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
  ) {
    return "image/png"
  }
  if (
    bytes.length >= 3
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
  ) {
    return "image/jpeg"
  }
  if (
    bytes.length >= 12
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  if (
    bytes.length >= 6
    && bytes[0] === 0x47
    && bytes[1] === 0x49
    && bytes[2] === 0x46
  ) {
    return "image/gif"
  }
  return undefined
}

function resolveBaseUrl(connection: ProviderConnection): string {
  const settingsBase = getConnectionSettings(connection)?.baseUrl
  return (
    typeof settingsBase === "string" ? settingsBase : (
      CODEX_API_BASE_URL
    )).replace(/\/+$/, "")
}

async function resolveAccessToken(
  connection: ProviderConnection,
  credential: ApiCredential,
): Promise<string> {
  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `Codex access token missing for connection "${connection.name}"`,
    )
  }
  return accessToken
}

function buildSessionHeaders(
  body: Record<string, unknown>,
  ctx?: RequestExecutionContext,
): { sessionId?: string; threadId?: string } {
  const { sessionId, threadId } = resolveCodexSessionHeaders(
    body as unknown as ResponsesPayload,
    ctx,
  )
  return { sessionId, threadId }
}

function buildUpstreamHeaders(
  accessToken: string,
  connection: ProviderConnection,
  session: { sessionId?: string; threadId?: string },
  ctx?: RequestExecutionContext,
  stream = false,
): Record<string, string> {
  return {
    ...buildCodexHeaders(accessToken, stream, {
      sessionId: session.sessionId,
      threadId: session.threadId,
      accountId: getCredentialContextString(connection, "oauthAccountId"),
    }),
    ...resolveCodexExtraHeaders(ctx),
  }
}

/**
 * 直接路径：gpt-image-1.5 / gpt-image-2 调上游 `/images/*`。
 * JSON body 透传（仅规范 model，edits 非流式删 stream）。
 */
export async function createCodexDirectImageOnce(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  endpoint: "generations" | "edits",
  body: Record<string, unknown>,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<CodexImageGenerationResponse> {
  if (connection.protocol !== "codex-native") {
    throw new Error("Codex images requires a Codex OAuth connection")
  }
  const accessToken = await resolveAccessToken(connection, credential)
  const rawModel = body.model
  if (typeof rawModel !== "string" || !rawModel.trim()) {
    throw new HTTPError(
      "Codex image request is missing model",
      new Response("Bad Request", { status: 400 }),
    )
  }
  const model = canonicalNativeModelId(rawModel)
  const url = `${resolveBaseUrl(connection)}/images/${endpoint}`
  const session = buildSessionHeaders(body, ctx)
  // 直出即透传：不对 body 做 sanitize（那是给 /responses input 数组用的，
  // 图片 body 没有 input 字段，调了也是原样返回，删掉避免误导）。
  const upstreamBody = {
    ...body,
    model,
    ...(endpoint === "edits" ? { stream: undefined } : {}),
  }
  const headers = buildUpstreamHeaders(
    accessToken,
    connection,
    session,
    ctx,
    false,
  )

  logger.debug("[codex] direct image upstream request", { model, endpoint })
  const response = await fetchWithConnectionProxy(connection, url, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    signal,
  })
  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Codex image",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }
  return (await response.json()) as CodexImageGenerationResponse
}

function extractUrlFromRecord(
  record: Record<string, unknown>,
): string | undefined {
  if (typeof record.image_url === "string" && record.image_url.trim()) {
    return record.image_url.trim()
  }
  if (typeof record.url === "string" && record.url.trim()) {
    return record.url.trim()
  }
  return undefined
}

function extractImageUrls(value: unknown): Array<string> {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : []
  }
  if (Array.isArray(value)) {
    const out: Array<string> = []
    for (const item of value) {
      if (typeof item === "string") {
        if (item.trim()) out.push(item.trim())
        continue
      }
      if (item && typeof item === "object") {
        const url = extractUrlFromRecord(item as Record<string, unknown>)
        if (url) out.push(url)
      }
    }
    return out
  }
  if (value && typeof value === "object") {
    const url = extractUrlFromRecord(value as Record<string, unknown>)
    return url ? [url] : []
  }
  return []
}

function buildImageTool(
  raw: Record<string, unknown>,
  routeModel: string,
  action: "generate" | "edit",
): Record<string, unknown> {
  const stringFields =
    action === "generate" ?
      ["size", "quality", "background", "output_format", "moderation"]
    : [
        "size",
        "quality",
        "background",
        "output_format",
        "input_fidelity",
        "moderation",
      ]
  const numberFields = ["output_compression", "partial_images"]
  const tool: Record<string, unknown> = {
    type: "image_generation",
    action,
    model: resolveImageToolModel(
      typeof raw.model === "string" ? raw.model : "",
      routeModel,
    ),
  }
  for (const field of stringFields) {
    const value = raw[field]
    if (typeof value === "string" && value.trim()) {
      tool[field] = value.trim()
    }
  }
  for (const field of numberFields) {
    const value = raw[field]
    if (typeof value === "number" && Number.isFinite(value)) {
      tool[field] = value
    }
  }
  return tool
}

function buildImageResponsesBody(
  prompt: string,
  images: Array<string>,
  tool: Record<string, unknown>,
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: prompt },
  ]
  for (const url of images) {
    content.push({ type: "input_image", image_url: url })
  }
  return {
    instructions: "",
    stream: true,
    reasoning: { effort: "medium", summary: "auto" },
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    model: IMAGE_TOOL_BASE_MODEL,
    store: false,
    tool_choice: { type: "image_generation" },
    tools: [tool],
    input: [{ type: "message", role: "user", content }],
  }
}

function buildImagesApiResponse(
  results: Array<ImageCallResult>,
  createdAt: number,
  firstMeta: ImageCallResult,
  responseFormat: "b64_json" | "url",
): CodexImageGenerationResponse {
  const data = results.map((img) => {
    const item: { b64_json?: string; url?: string; revised_prompt?: string } =
      {}
    if (img.revisedPrompt) item.revised_prompt = img.revisedPrompt
    if (responseFormat === "url") {
      item.url = `data:${mimeTypeFromOutputFormat(img.outputFormat)};base64,${img.result}`
    } else {
      item.b64_json = img.result
    }
    return item
  })
  const response: CodexImageGenerationResponse = {
    created: createdAt,
    data,
  }
  if (firstMeta.background) response.background = firstMeta.background
  if (firstMeta.outputFormat) response.output_format = firstMeta.outputFormat
  if (firstMeta.quality) response.quality = firstMeta.quality
  if (firstMeta.size.length > 0) response.size = firstMeta.size
  return response
}

function extractImageResults(response: ResponsesResponse): {
  results: Array<ImageCallResult>
  createdAt: number
} {
  const results: Array<ImageCallResult> = []
  const output = Array.isArray(response.output) ? response.output : []
  for (const item of output) {
    if (
      !item
      || typeof item !== "object"
      || (item as { type?: unknown }).type !== "image_generation_call"
    ) {
      continue
    }
    const record = item as unknown as Record<string, unknown>
    const result = typeof record.result === "string" ? record.result.trim() : ""
    if (!result) continue
    results.push({
      result,
      revisedPrompt:
        typeof record.revised_prompt === "string" ?
          record.revised_prompt.trim()
        : "",
      outputFormat:
        typeof record.output_format === "string" ?
          record.output_format.trim()
        : "",
      size: typeof record.size === "string" ? record.size.trim() : "",
      background:
        typeof record.background === "string" ? record.background.trim() : "",
      quality: typeof record.quality === "string" ? record.quality.trim() : "",
    })
  }
  const createdAt =
    typeof response.created_at === "number" && response.created_at > 0 ?
      response.created_at
    : Math.floor(Date.now() / 1000)
  return { results, createdAt }
}

/**
 * responses-tool 路径：非直出模型走 `/responses` + image_generation tool。
 * 上游恒走流式再收集（与普通 turn 一致），返回拼好的 images 响应。
 */
async function createCodexImageViaResponses(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  raw: Record<string, unknown>,
  action: "generate" | "edit",
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<CodexImageGenerationResponse> {
  const accessToken = await resolveAccessToken(connection, credential)
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : ""
  if (!prompt) {
    throw new HTTPError(
      "Codex image request is missing prompt",
      new Response("Bad Request", { status: 400 }),
    )
  }
  const images =
    action === "edit" ? extractImageUrls(raw.images ?? raw.image) : []
  const tool = buildImageTool(raw, "", action)
  if (action === "edit") {
    const maskUrls = extractImageUrls(raw.mask)
    if (maskUrls[0]) {
      tool["input_image_mask"] = { image_url: maskUrls[0] }
    }
  }
  const responsesBody = buildImageResponsesBody(prompt, images, tool)
  const session = buildSessionHeaders(responsesBody, ctx)
  const headers = buildUpstreamHeaders(
    accessToken,
    connection,
    session,
    ctx,
    true,
  )
  const url = `${resolveBaseUrl(connection)}/responses`
  const upstreamBody = sanitizeCodexInput({
    ...responsesBody,
    input: convertSystemRoleToDeveloper(responsesBody.input),
  })

  const response = await fetchWithConnectionProxy(connection, url, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
    signal,
  })
  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Codex image via responses",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }
  const stream = await safeSseStream(response, detectResponsesStreamError)
  const collected = await collectResponsesFromEventStream(
    stream as unknown as AsyncIterable<CopilotStreamEventLike>,
    IMAGE_TOOL_BASE_MODEL,
  )
  const { results, createdAt } = extractImageResults(collected)
  if (results.length === 0) {
    throw new Error("upstream did not return image output")
  }
  const first = results[0] ?? {
    result: "",
    revisedPrompt: "",
    outputFormat: "",
    size: "",
    background: "",
    quality: "",
  }
  return buildImagesApiResponse(
    results,
    createdAt,
    first,
    normalizeResponseFormat(raw.response_format),
  )
}

export async function createCodexImageGeneration(
  subject: { connection: ProviderConnection; credential: ApiCredential },
  raw: CodexImageGenerationRequest,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<CodexImageGenerationResponse> {
  const { connection } = subject
  if (connection.protocol !== "codex-native") {
    throw new Error("Codex images requires a Codex OAuth connection")
  }
  const record = raw as unknown as Record<string, unknown>
  const model = typeof record.model === "string" ? record.model : ""
  if (isDirectImageModel(model)) {
    return createCodexDirectImageOnce(
      subject,
      "generations",
      record,
      signal,
      ctx,
    )
  }
  return createCodexImageViaResponses(subject, record, "generate", signal, ctx)
}

export async function createCodexImageEdit(
  subject: { connection: ProviderConnection; credential: ApiCredential },
  raw: CodexImageEditRequest,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<CodexImageGenerationResponse> {
  const { connection } = subject
  if (connection.protocol !== "codex-native") {
    throw new Error("Codex images requires a Codex OAuth connection")
  }
  const record = raw as unknown as Record<string, unknown>
  const model = typeof record.model === "string" ? record.model : ""
  if (isDirectImageModel(model)) {
    return createCodexDirectImageOnce(subject, "edits", record, signal, ctx)
  }
  return createCodexImageViaResponses(subject, record, "edit", signal, ctx)
}

export function isCodexDirectImageModel(model: unknown): boolean {
  return typeof model === "string" && isDirectImageModel(model)
}
