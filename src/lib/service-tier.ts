/** Service tiers are wire-specific; matching names can be forwarded unchanged. */
export type OpenAIServiceTier =
  | "auto"
  | "default"
  | "flex"
  | "priority"
  | "scale"
export type AnthropicServiceTier = "auto" | "standard_only"

export function readOpenAIServiceTier(
  value: unknown,
): OpenAIServiceTier | undefined {
  switch (value) {
    case "auto":
    case "default":
    case "flex":
    case "priority":
    case "scale":
      return value
    default:
      return undefined
  }
}

export function readAnthropicServiceTier(
  value: unknown,
): AnthropicServiceTier | undefined {
  return value === "auto" || value === "standard_only" ? value : undefined
}
