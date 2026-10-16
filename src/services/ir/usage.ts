import type { IRUsage } from "~/services/ir/types"

/** Merge cumulative snapshots, not distinct calls. Missing/placeholder counts
 * must not erase counts reported on an earlier frame. */
export function mergeUsage(
  previous: IRUsage | undefined,
  next: IRUsage,
): IRUsage {
  const merged = { ...previous, source: next.source }
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cacheWrite1hTokens",
    "reasoningTokens",
    "totalTokens",
  ] as const) {
    const value = next[key]
    if (value !== undefined && (value > 0 || merged[key] === undefined)) {
      merged[key] = value
    }
  }
  return merged
}
