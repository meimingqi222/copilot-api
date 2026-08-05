/**
 * Shared thinking configuration utilities.
 *
 * Provides level↔budget conversion and Gemini model format detection
 * used by the Anthropic and Antigravity translation layers.
 */

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
