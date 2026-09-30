import type { GeminiPart } from "~/services/protocols/gemini"
import type { IRPart, IRThinkingPart } from "~/services/ir/types"

import { sanitizeId } from "~/lib/id-sanitizer"

/**
 * Decodes one Gemini wire part into IR.
 *
 * Request and result directions share this: a thought part is a thinking part
 * whose `thoughtSignature` is a Gemini-issued signature, valid only for the
 * unchanged text and only on the Gemini wire (enforced during preflight).
 */
export function decodeGeminiPart(part: GeminiPart): IRPart | undefined {
  if (part.functionCall)
    return {
      type: "tool_call",
      id: sanitizeId(part.functionCall.id ?? part.functionCall.name),
      name: part.functionCall.name,
      arguments: JSON.stringify(part.functionCall.args ?? {}),
    }
  if (part.functionResponse)
    return {
      type: "tool_result",
      callId: part.functionResponse.id ?? part.functionResponse.name,
      content: [
        {
          type: "text",
          text: JSON.stringify(part.functionResponse.response ?? {}),
        },
      ],
    }
  if (part.inlineData && part.inlineData.data)
    return {
      type: "image",
      source: {
        type: "base64",
        mediaType: part.inlineData.mimeType,
        data: part.inlineData.data,
      },
    }
  if (part.fileData?.fileUri)
    return {
      type: "image",
      source: { type: "url", url: part.fileData.fileUri },
    }
  if (typeof part.text !== "string") return undefined
  if (part.thought) {
    const thinking: IRThinkingPart = {
      type: "thinking",
      text: part.text,
      ...(part.thoughtSignature && {
        signature: part.thoughtSignature,
        signedText: part.text,
      }),
      source: { wire: "gemini" },
    }
    return thinking
  }
  return { type: "text", text: part.text }
}
