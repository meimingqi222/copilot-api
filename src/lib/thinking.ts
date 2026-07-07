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
