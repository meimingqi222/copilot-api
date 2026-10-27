import type { QuotaSnapshot } from "./types"

/**
 * 只有「已用百分比」窗口的 quota fetcher 共用的快照骨架
 * （Command Code / Factory / ZCode）：头号百分比取最紧的窗口，聊天额度取
 * 第一个窗口。窗口为空即视为不限量。
 */
export function snapshotFromWindows(input: {
  provider: string
  windows: ReadonlyArray<{ usedPercent: number }>
  details: Record<string, unknown>
}): QuotaSnapshot {
  const base: QuotaSnapshot = {
    fetchedAt: Date.now(),
    provider: input.provider,
    unlimited: input.windows.length === 0,
    details: input.details,
  }
  if (input.windows.length === 0) return base

  const usedPercent = Math.max(...input.windows.map((w) => w.usedPercent))
  const primary = input.windows[0]!
  return {
    ...base,
    premiumInteractionsRemaining: Math.round(Math.max(0, 100 - usedPercent)),
    premiumInteractionsTotal: 100,
    chatRemaining: Math.max(0, Math.round(100 - primary.usedPercent)),
    chatTotal: 100,
  }
}
