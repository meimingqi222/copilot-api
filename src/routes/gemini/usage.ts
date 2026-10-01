import type { Context } from "hono"

import type { UsageIdentity } from "~/lib/usage"
import type {
  GeminiGenerateContentResponse,
  GeminiUsageMetadata,
} from "~/services/protocols/gemini"

import { applyUsageIdentity, recordUsage } from "~/lib/usage"

interface RecordGeminiUsageOpts {
  c: Context
  identity: UsageIdentity
  usage: GeminiUsageMetadata | undefined
  tps?: number
  streaming: boolean
  ttftMs?: number
}

/**
 * Records one usage row for a Gemini request.
 *
 * Gemini reports thinking tokens separately (`thoughtsTokenCount`), which are
 * part of `candidatesTokenCount`; they are attributed to the reasoning bucket
 * so the row's completion count stays comparable with the other protocols.
 */
export function recordGeminiUsage(opts: RecordGeminiUsageOpts): void {
  const { c, identity, usage, tps, streaming, ttftMs } = opts
  const model = c.get("model")
  if (!model) return
  applyUsageIdentity(c, identity)
  const cacheReadTokens = usage?.cachedContentTokenCount ?? 0
  const promptTokens = Math.max(
    (usage?.promptTokenCount ?? 0) - cacheReadTokens,
    0,
  )
  recordUsage({
    c,
    accountId: identity.ownerId,
    model,
    promptTokens,
    completionTokens: usage?.candidatesTokenCount ?? 0,
    totalTokens:
      usage?.totalTokenCount
      ?? (usage?.promptTokenCount ?? 0) + (usage?.candidatesTokenCount ?? 0),
    cacheReadTokens,
    cacheWriteTokens: 0,
    tps,
    streaming,
    ttftMs,
    ...(usage ? {} : { finishReason: "usage_missing" }),
  })
}

/**
 * Reads the terminal signals out of one Gemini SSE frame.
 *
 * Returns `undefined` for frames that are not JSON (keep-alives, comments).
 */
export function parseGeminiFrame(data: string):
  | {
      finishReason?: string
      usageMetadata?: GeminiUsageMetadata
      hasContent: boolean
    }
  | undefined {
  let parsed: GeminiGenerateContentResponse
  try {
    parsed = JSON.parse(data) as GeminiGenerateContentResponse
  } catch {
    return undefined
  }
  const candidate = parsed.candidates?.[0]
  const hasContent = (candidate?.content?.parts ?? []).some(
    (part) => part.text !== undefined || part.functionCall !== undefined,
  )
  return {
    ...(candidate?.finishReason && { finishReason: candidate.finishReason }),
    ...(parsed.usageMetadata && { usageMetadata: parsed.usageMetadata }),
    hasContent,
  }
}
