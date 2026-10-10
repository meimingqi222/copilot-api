import type { ContentPart } from "~/services/protocols/chat/types"
import type { AnthropicImageBlock } from "~/services/protocols/anthropic/types"
import type { IRImagePart } from "~/services/ir/types"

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i

/** MIME for a Codex `image_generation_call` `output_format`. Unknown formats stay PNG. */
export function mimeTypeFromOutputFormat(
  outputFormat: string | undefined,
): string {
  switch (outputFormat?.trim().toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "webp":
      return "image/webp"
    case "gif":
      return "image/gif"
    default:
      return "image/png"
  }
}

/**
 * A completed Codex image call. Partial previews are ignored: clients that
 * cannot render `image_generation_call` only need the final bytes.
 */
export function imagePartFromGenerationCall(
  item: Record<string, unknown>,
): IRImagePart | undefined {
  const raw = typeof item.result === "string" ? item.result.trim() : ""
  if (!raw) return undefined
  const dataUrl = DATA_URL.exec(raw.replaceAll(/\s/g, ""))
  const data = dataUrl ? dataUrl[2] : raw.replaceAll(/\s/g, "")
  if (!data) return undefined
  const outputFormat =
    typeof item.output_format === "string" ? item.output_format : undefined
  return {
    type: "image",
    source: {
      type: "base64",
      mediaType:
        dataUrl?.[1]?.toLowerCase() ?? mimeTypeFromOutputFormat(outputFormat),
      data,
    },
    ...(typeof item.id === "string" && item.id ? { id: item.id } : {}),
  }
}

/** Chat `image_url` part. Base64 sources become a data URL. */
export function imagePartToChat(part: IRImagePart): ContentPart {
  const url =
    part.source.type === "url" ?
      part.source.url
    : `data:${part.source.mediaType};base64,${part.source.data}`
  return {
    type: "image_url",
    image_url: {
      url,
      ...(part.source.type === "url" && part.source.detail ?
        { detail: part.source.detail }
      : {}),
    },
  }
}

/** Messages image block, or undefined when that wire cannot represent the source. */
export function imagePartToMessages(
  part: IRImagePart,
): AnthropicImageBlock | undefined {
  if (part.source.type === "url") {
    if (!/^https?:\/\//i.test(part.source.url)) return undefined
    return { type: "image", source: { type: "url", url: part.source.url } }
  }
  if (!IMAGE_MEDIA_TYPES.has(part.source.mediaType)) return undefined
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: part.source.mediaType as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp",
      data: part.source.data,
    },
  }
}

/** Responses output item for a generated image. Never an `image_generation_call`. */
export function responsesImageMessage(
  part: IRImagePart,
  id: string,
): Record<string, unknown> {
  const url =
    part.source.type === "url" ?
      part.source.url
    : `data:${part.source.mediaType};base64,${part.source.data}`
  return {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_image", image_url: url }],
  }
}
