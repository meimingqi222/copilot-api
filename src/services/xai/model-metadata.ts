import { normalizeXaiModelBase } from "./session"

/**
 * CPA-aligned xAI catalog hints (models.json thinking.levels / context_length).
 * Used when the live model cache only has `{ streaming: true }` and omits
 * reasoning / context fields.
 *
 * More-specific prefixes must come first (e.g. multi-agent before grok-4.20).
 */
const XAI_CATALOG_RULES: Array<{
  test: (base: string) => boolean
  contextWindow?: number
  reasoningLevels?: ReadonlyArray<string>
}> = [
  {
    test: (base) => base.startsWith("grok-4.6"),
    contextWindow: 500_000,
    reasoningLevels: ["low", "medium", "high"],
  },
  {
    test: (base) => base.startsWith("grok-4.5"),
    contextWindow: 500_000,
    reasoningLevels: ["low", "medium", "high"],
  },
  {
    test: (base) => base.startsWith("grok-4.3"),
    contextWindow: 1_000_000,
    reasoningLevels: ["none", "low", "medium", "high"],
  },
  {
    test: (base) => base.startsWith("grok-4.20-multi-agent"),
    contextWindow: 2_000_000,
    reasoningLevels: ["low", "medium", "high"],
  },
  {
    test: (base) => base.startsWith("grok-4.20"),
    contextWindow: 2_000_000,
  },
  {
    test: (base) => base.startsWith("grok-3-mini"),
    contextWindow: 131_072,
    reasoningLevels: ["low", "medium", "high"],
  },
  {
    test: (base) => base.startsWith("grok-composer-"),
    contextWindow: 200_000,
  },
  {
    test: (base) => base.startsWith("grok-build-"),
    contextWindow: 256_000,
  },
]

export type XaiCatalogHints = {
  contextWindow?: number
  reasoningLevels?: ReadonlyArray<string>
}

/** Resolve CPA-style context / thinking metadata for an xAI model id. */
export function getXaiCatalogHints(model: string): XaiCatalogHints {
  const base = normalizeXaiModelBase(model)
  if (!base) return {}
  for (const rule of XAI_CATALOG_RULES) {
    if (rule.test(base)) {
      return {
        contextWindow: rule.contextWindow,
        reasoningLevels: rule.reasoningLevels,
      }
    }
  }
  return {}
}

/**
 * Models that accept Responses API `reasoning.effort`.
 * Keep aligned with CPA model-registry thinking.levels for xAI.
 */
export function xaiSupportsReasoningEffort(model: string): boolean {
  const levels = getXaiCatalogHints(model).reasoningLevels
  return Array.isArray(levels) && levels.length > 0
}
