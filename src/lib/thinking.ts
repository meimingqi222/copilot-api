/**
 * Shared thinking utilities.
 *
 * Provides level↔budget conversion, Gemini model format detection, and the
 * canonical thinking-signature alias chain, used by the Anthropic, Antigravity
 * and Windsurf translation layers.
 */

/**
 * Extracts a thinking signature under any of the spellings the various proxy
 * implementations use.
 *
 * Lives here rather than next to one protocol because both directions need the
 * same chain: a response is written under one spelling and a client replays it
 * verbatim on the next request. The Windsurf path emits `reasoning_opaque`
 * specifically, so a request-side reader that omits it silently drops the
 * signature on every round trip.
 *
 * All three extractors below chain with `||`, not `??`: an empty string is an
 * absent value here, not a present one. Upstreams routinely emit `""` under
 * the spelling they do not use — a turn with no thinking comes back as
 * `reasoning_content: ""` — and a client replaying such a turn sends the empty
 * string alongside the spelling that does carry the reasoning. Stopping at it
 * drops the chain of thought, and which spelling wins is then an accident of
 * the order below rather than of what the message actually holds.
 */
export function extractSignatureAlias(source: {
  reasoning_opaque?: string | null
  thinking_signature?: string | null
  reasoning_signature?: string | null
  signature?: string | null
}): string | undefined {
  return (
    source.reasoning_opaque
    || source.thinking_signature
    || source.reasoning_signature
    || source.signature
    || undefined
  )
}

/**
 * Top-level reasoning text under any of the spellings in circulation.
 *
 * Same reason as `extractSignatureAlias`: each provider writes one spelling
 * (Windsurf `reasoning_text`, Antigravity `reasoning_content`, OpenRouter
 * `reasoning`), and any of them can come back on the next request. A reader
 * that hard-codes one spelling drops the whole chain of thought.
 */
export function extractReasoningTextAlias(source: {
  reasoning_text?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  thinking?: string | null
}): string | undefined {
  return (
    source.reasoning_text
    || source.reasoning_content
    || source.reasoning
    || source.thinking
    || undefined
  )
}

/**
 * Text of a single reasoning block — a `reasoning_details` entry or a
 * reasoning/thinking content part.
 *
 * Distinct from `extractReasoningTextAlias`, which reads the *message*-level
 * fields. `text` leads because that is what every emitter in this repo writes
 * and what the OpenRouter `reasoning_details` convention uses; `reasoning` and
 * `thinking` are the fallbacks other proxies emit.
 */
export function extractReasoningBlockText(source: {
  text?: string | null
  reasoning?: string | null
  thinking?: string | null
}): string | undefined {
  return source.text || source.reasoning || source.thinking || undefined
}

/** Structural view of a chat content part; avoids a lib→services type import. */
interface ReasoningPartLike {
  type: string
  text?: string
  reasoning?: string
  thinking?: string
}

/**
 * Reasoning carried as content parts rather than a top-level field,
 * concatenated in order.
 *
 * This is the shape our own translators emit whenever reasoning interleaves
 * with text (`protocols/openai/messages-to-chat.ts`,
 * `windsurf/collect-response.ts`, `copilot/responses-to-chat.ts`), so a
 * request-side reader that only checks top-level fields misses it.
 */
export function extractReasoningPartsText(
  content: string | Array<ReasoningPartLike> | null | undefined,
): string {
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const part of content) {
    if (part.type !== "reasoning" && part.type !== "thinking") continue
    text += extractReasoningBlockText(part) ?? ""
  }
  return text
}

/** Standard reasoning effort levels from lowest to highest. */
export type ReasoningEffortLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"

export type ReasoningEffort = ReasoningEffortLevel | "none" | "auto"

export type ThinkingSuffixConfig =
  | { mode: "level"; effort: ReasoningEffortLevel }
  | { mode: "budget"; budget: number }
  | { mode: "none"; effort: "none" }
  | { mode: "auto"; effort: "auto" }

export interface ParsedThinkingModel {
  model: string
  config?: ThinkingSuffixConfig
}

export function parseThinkingModel(model: string): ParsedThinkingModel {
  const trimmed = model.trim()
  const lastOpen = trimmed.lastIndexOf("(")
  if (lastOpen <= 0 || !trimmed.endsWith(")")) {
    return { model: trimmed }
  }

  const baseModel = trimmed.slice(0, lastOpen).trim()
  const suffix = trimmed
    .slice(lastOpen + 1, -1)
    .trim()
    .toLowerCase()
  if (!baseModel || !suffix) {
    return { model: trimmed }
  }

  if (suffix === "none") {
    return { model: baseModel, config: { mode: "none", effort: "none" } }
  }
  if (suffix === "auto" || suffix === "-1") {
    return { model: baseModel, config: { mode: "auto", effort: "auto" } }
  }
  if (
    suffix === "minimal"
    || suffix === "low"
    || suffix === "medium"
    || suffix === "high"
    || suffix === "xhigh"
  ) {
    return {
      model: baseModel,
      config: { mode: "level", effort: suffix },
    }
  }
  if (/^\d+$/.test(suffix)) {
    const budget = Number(suffix)
    if (Number.isSafeInteger(budget)) {
      return { model: baseModel, config: { mode: "budget", budget } }
    }
  }

  return { model: trimmed }
}

export function thinkingConfigToReasoningEffort(
  config: ThinkingSuffixConfig,
): ReasoningEffort | undefined {
  if (
    config.mode === "level"
    || config.mode === "none"
    || config.mode === "auto"
  ) {
    return config.effort
  }
  return budgetToLevel(config.budget)
}

export function thinkingConfigToBudget(
  config: ThinkingSuffixConfig,
): number | undefined {
  if (config.mode === "budget") return config.budget
  if (config.mode === "none") return 0
  if (config.mode === "auto") return -1
  return LEVEL_TO_BUDGET[config.effort]
}

export function thinkingConfigToAnthropic(config: ThinkingSuffixConfig): {
  thinking:
    | { type: "enabled"; budget_tokens: number }
    | { type: "adaptive" }
    | { type: "disabled" }
  output_config?: { effort: "low" | "medium" | "high" }
} {
  if (config.mode === "none") {
    return { thinking: { type: "disabled" } }
  }
  if (config.mode === "auto") {
    return { thinking: { type: "adaptive" } }
  }
  if (config.mode === "budget") {
    if (config.budget <= 0) {
      return { thinking: { type: "disabled" } }
    }
    return { thinking: { type: "enabled", budget_tokens: config.budget } }
  }
  let effort: "low" | "medium" | "high"
  if (config.effort === "minimal" || config.effort === "low") {
    effort = "low"
  } else if (config.effort === "medium") {
    effort = "medium"
  } else {
    effort = "high"
  }
  return {
    thinking: { type: "adaptive" },
    output_config: { effort },
  }
}

export function thinkingConfigToResponsesEffort(
  config: ThinkingSuffixConfig,
): "low" | "medium" | "high" | undefined {
  const effort = thinkingConfigToReasoningEffort(config)
  if (effort === "none" || effort === "auto" || effort === undefined) {
    return undefined
  }
  if (effort === "minimal" || effort === "low") return "low"
  if (effort === "medium") return "medium"
  return "high"
}

/**
 * Level → Budget mapping (tokens). Matches CPA's levelToBudgetMap.
 * Used when translating discrete effort levels to numeric thinkingBudget
 * for providers that only accept budget format (e.g. Gemini 2.5).
 */
export const LEVEL_TO_BUDGET: Record<string, number> = {
  none: 0,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
}

/**
 * Budget → Level thresholds. Matches CPA's ConvertBudgetToLevel.
 * Maps numeric budget values to the nearest standard effort level.
 */
export function budgetToLevel(
  budget: number,
): ReasoningEffortLevel | "none" | undefined {
  if (budget < 0) return undefined
  if (budget === 0) return "none"
  if (budget <= 512) return "minimal"
  if (budget <= 1024) return "low"
  if (budget <= 8192) return "medium"
  if (budget <= 24576) return "high"
  return "xhigh"
}

/**
 * Returns true when the Gemini model uses `thinkingLevel` (string) format.
 * Gemini 3+ supports discrete levels; Gemini 2.x only supports
 * `thinkingBudget` (numeric).
 */
export function geminiSupportsLevelFormat(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes("gemini-3") || m.includes("gemini-4")
}
