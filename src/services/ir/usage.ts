import type { IRUsage } from "~/services/ir/types"
import type { UsageMetadata } from "~/lib/usage-translation"

export function decodeUsageMetadata(
  usage: UsageMetadata,
): Pick<IRUsage, "contextWindow" | "usagePending"> {
  return {
    ...(usage.context_window && { contextWindow: usage.context_window }),
    ...(usage.usage_status === "pending" && { usagePending: true }),
  }
}

export function encodeUsageMetadata(usage: IRUsage | undefined): UsageMetadata {
  return {
    ...(usage?.contextWindow && { context_window: usage.contextWindow }),
    ...(usage?.usagePending && { usage_status: "pending" as const }),
  }
}

/** Merge cumulative snapshots, not distinct calls. Missing/placeholder counts
 * must not erase counts reported on an earlier frame. */
export function mergeUsage(
  previous: IRUsage | undefined,
  next: IRUsage,
): IRUsage {
  const hasReportedInfo =
    next.usagePending !== undefined
    || (next.inputTokens ?? 0) > 0
    || (next.outputTokens ?? 0) > 0
    || (next.cacheReadTokens ?? 0) > 0
    || (next.cacheWriteTokens ?? 0) > 0
    || (next.cacheWrite1hTokens ?? 0) > 0
    || (next.reasoningTokens ?? 0) > 0
    || (next.totalTokens ?? 0) > 0
  const source =
    previous?.source === "estimated" && !hasReportedInfo ?
      "estimated"
    : next.source
  const merged = { ...previous, source }
  if (next.contextWindow !== undefined)
    merged.contextWindow = next.contextWindow
  const previousIsReported =
    previous !== undefined
    && previous.source !== "estimated"
    && previous.usagePending !== true
  if (previousIsReported && next.usagePending) {
    return merged
  }
  if (next.usagePending !== undefined) merged.usagePending = next.usagePending
  else if (
    merged.usagePending
    && (next.inputTokens !== undefined || next.outputTokens !== undefined)
  )
    delete merged.usagePending
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
    // Explicit pending zeros supersede an estimated Messages message_start.
    if (
      value !== undefined
      && (next.usagePending || value > 0 || merged[key] === undefined)
    ) {
      merged[key] = value
    }
  }
  return merged
}
