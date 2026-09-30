import type {
  GeminiCandidate,
  GeminiGenerateContentResponse,
  GeminiPart,
  GeminiUsageMetadata,
} from "~/services/protocols/gemini"
import type { IRPart, IRStop, IRUsage, ResultIR } from "~/services/ir/types"

import { sanitizeId } from "~/lib/id-sanitizer"

import { decodeGeminiPart } from "./part"

export function stopFromGemini(finishReason: string | undefined): IRStop {
  switch (finishReason) {
    case undefined:
      return { reason: "unknown" }
    case "STOP":
      return { reason: "complete", raw: finishReason }
    case "MAX_TOKENS":
      return { reason: "max_tokens", raw: finishReason }
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return { reason: "refusal", raw: finishReason }
    case "MALFORMED_FUNCTION_CALL":
      return { reason: "error", raw: finishReason }
    default:
      return { reason: "complete", raw: finishReason }
  }
}

export function geminiFinishReason(
  stop: IRStop | undefined,
): GeminiCandidate["finishReason"] {
  if (stop?.reason === "max_tokens") return "MAX_TOKENS"
  if (stop?.reason === "refusal") return "SAFETY"
  return "STOP"
}

export function geminiUsage(usage: GeminiUsageMetadata): IRUsage {
  return {
    source: "reported",
    ...(usage.promptTokenCount !== undefined && {
      inputTokens: usage.promptTokenCount,
    }),
    ...(usage.candidatesTokenCount !== undefined && {
      outputTokens: usage.candidatesTokenCount,
    }),
    ...(usage.totalTokenCount !== undefined && {
      totalTokens: usage.totalTokenCount,
    }),
    ...(usage.cachedContentTokenCount !== undefined && {
      cacheReadTokens: usage.cachedContentTokenCount,
    }),
    ...(usage.thoughtsTokenCount !== undefined && {
      reasoningTokens: usage.thoughtsTokenCount,
    }),
  }
}

export function geminiUsageMetadata(
  usage: IRUsage | undefined,
): GeminiUsageMetadata {
  return {
    ...(usage?.inputTokens !== undefined && {
      promptTokenCount: usage.inputTokens,
    }),
    ...(usage?.outputTokens !== undefined && {
      candidatesTokenCount: usage.outputTokens,
    }),
    ...(usage?.totalTokens !== undefined && {
      totalTokenCount: usage.totalTokens,
    }),
    ...(usage?.cacheReadTokens !== undefined && {
      cachedContentTokenCount: usage.cacheReadTokens,
    }),
    ...(usage?.reasoningTokens !== undefined && {
      thoughtsTokenCount: usage.reasoningTokens,
    }),
  }
}

export function decodeGeminiResult(
  response: GeminiGenerateContentResponse,
): ResultIR {
  const candidate = response.candidates?.[0]
  const parts: Array<IRPart> = []
  for (const part of candidate?.content?.parts ?? []) {
    const decoded = decodeGeminiPart(part)
    if (decoded) parts.push(decoded)
  }
  const blocked = response.promptFeedback?.blockReason
  return {
    id: sanitizeId(response.responseId ?? "gemini-response"),
    model: response.modelVersion ?? "",
    source: { wire: "gemini" },
    parts,
    stop:
      candidate ? stopFromGemini(candidate.finishReason)
      : blocked ? { reason: "refusal", raw: blocked }
      : { reason: "unknown" },
    ...(response.usageMetadata && {
      usage: geminiUsage(response.usageMetadata),
    }),
  }
}

function toGeminiResultPart(part: IRPart): GeminiPart | undefined {
  if (part.type === "text") return { text: part.text }
  if (part.type === "thinking")
    return {
      text: part.text,
      thought: true,
      ...(part.signature && { thoughtSignature: part.signature }),
    }
  if (part.type === "tool_call") {
    let args: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(part.arguments)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        args = parsed as Record<string, unknown>
    } catch {
      /* Truncated tool JSON cannot be represented; send an empty object. */
    }
    return { functionCall: { name: part.name, args } }
  }
  return undefined
}

export function encodeGeminiResult(
  result: ResultIR,
): GeminiGenerateContentResponse {
  const parts = result.parts
    .map(toGeminiResultPart)
    .filter((part): part is GeminiPart => part !== undefined)
  return {
    candidates: [
      {
        index: 0,
        content: { role: "model", parts },
        finishReason: geminiFinishReason(result.stop),
      },
    ],
    ...(result.usage && { usageMetadata: geminiUsageMetadata(result.usage) }),
    ...(result.model && { modelVersion: result.model }),
    responseId: result.id,
  }
}
