import { HTTPError } from "~/lib/error"
import { performanceFetch } from "~/lib/upstream-performance"
import type {
  CodexImageEditRequest,
  CodexImageGenerationResponse,
} from "~/services/codex/create-images"
import { ensureCodebuddyAccessToken } from "~/services/codebuddy/token-refresh"
import {
  buildCodebuddyHeaders,
  resolveCodebuddyBaseUrl,
} from "~/services/protocols/codebuddy-native"
import {
  connectionFetchInit,
  handleUpstreamFailure,
} from "~/services/protocols/shared"
import type { AdapterParams } from "~/services/protocols/types"

function asInlineImage(image: unknown): string {
  const value =
    typeof image === "string" ? image
    : image && typeof image === "object" && "image_url" in image ?
      image.image_url
    : image && typeof image === "object" && "url" in image ? image.url
    : undefined
  if (
    typeof value === "string"
    && /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(value)
  ) {
    return value
  }
  throw new HTTPError(
    "WorkBuddy image edits require inline image data URLs",
    new Response(null, { status: 400 }),
  )
}

export async function createWorkbuddyImage(
  {
    connection,
    credential,
    target,
    payload,
    signal,
  }: AdapterParams<CodexImageEditRequest>,
  action: "generations" | "edits",
): Promise<CodexImageGenerationResponse> {
  let model = target.upstreamModelId
  let images: Array<string> | undefined
  if (action === "edits") {
    const editor = connection.models?.find(
      (entry) =>
        entry.upstreamId === model && entry.endpoints.includes("images"),
    )?.metadata?.workbuddyImageEditor
    if (
      typeof editor !== "string"
      || (editor !== model && editor !== `${model}-edit`)
    ) {
      throw new HTTPError(
        "WorkBuddy does not list an editor for this model",
        new Response(null, { status: 400 }),
      )
    }
    model = editor
    const input = payload.images ?? (payload.image ? [payload.image] : [])
    if (!Array.isArray(input) || !input.length) {
      throw new HTTPError(
        "WorkBuddy image edits require an input image",
        new Response(null, { status: 400 }),
      )
    }
    images = input.map(asInlineImage)
  }
  const gpt = model.toLowerCase().includes("gpt-image")
  const body = {
    model,
    prompt: payload.prompt,
    n: Array.isArray(payload.n) ? payload.n[0] : (payload.n ?? 1),
    ...(payload.size && (gpt || payload.size !== "auto") ?
      { size: payload.size }
    : {}),
    ...(gpt ?
      {
        quality: payload.quality,
        background: payload.background,
        output_format: payload.output_format,
        response_format: "b64_json",
        ...(images && payload.mask ?
          { mask: asInlineImage(payload.mask) }
        : {}),
      }
    : {}),
    ...(images ? { image: images } : {}),
  }
  const token = await ensureCodebuddyAccessToken(connection, credential, signal)
  const response = await performanceFetch(
    `${resolveCodebuddyBaseUrl(connection)}/images/${action}`,
    connectionFetchInit(connection, {
      method: "POST",
      headers: buildCodebuddyHeaders(connection, credential, token),
      body: JSON.stringify(body),
      signal,
      redirect: "manual",
    }),
  )
  if (!response.ok) {
    await handleUpstreamFailure(
      response,
      credential,
      "WorkBuddy image request failed",
      "codebuddy-native",
    )
  }

  const raw = (await response.json()) as {
    code?: number | string
    msg?: string
    data?: unknown
  }
  const result = raw?.code === undefined ? raw : raw.data
  if (
    (raw?.code !== undefined && String(raw.code) !== "0")
    || !result
    || typeof result !== "object"
    || !("data" in result)
    || !Array.isArray(result.data)
  ) {
    throw new HTTPError(
      raw?.msg || "Invalid WorkBuddy image response",
      new Response(null, { status: 502 }),
    )
  }
  return result as CodexImageGenerationResponse
}
