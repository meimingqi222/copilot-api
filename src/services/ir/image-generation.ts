import type { IRImagePart } from "~/services/ir/types"
import { LocalPayloadUnsupportedError } from "~/lib/error"

export const MESSAGES_IMAGE_OUTPUT_ERROR =
  "The Messages API cannot return generated images. Use /v1/images/generations, /v1/responses, or a Chat/Gemini client with image output support."

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i

/** MIME for a Codex `image_generation_call` `output_format`. Unknown formats stay PNG. */
function mimeTypeFromOutputFormat(outputFormat: string | undefined): string {
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
  const normalized = raw.replaceAll(/\s/g, "")
  const dataUrl = DATA_URL.exec(normalized)
  const data = dataUrl ? dataUrl[2] : normalized
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

/** Responses images are tool result items, not message content blocks. */
export function responsesImageCall(
  part: IRImagePart,
  id: string,
): Record<string, unknown> {
  if (part.source.type !== "base64")
    throw new LocalPayloadUnsupportedError(
      "Responses image output requires inline image bytes, not an image URL",
    )
  return {
    type: "image_generation_call",
    id,
    status: "completed",
    result: part.source.data,
    output_format: part.source.mediaType.replace(/^image\//, ""),
  }
}
