import type { Context } from "hono"

import type { IRUsage } from "~/services/ir/types"

interface PricingRound {
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface RequestPricingRounds {
  accountId: string
  rounds: Array<PricingRound>
}

// Internal accounting metadata; never add round breakdowns to client wire usage.
const requestRounds = new WeakMap<Context, RequestPricingRounds>()

export function clearUsagePricingRounds(c: Context | undefined): void {
  if (c) requestRounds.delete(c)
}

export function createUsagePricingRecorder(
  c: Context | undefined,
  accountId: string,
): (usage: IRUsage | undefined) => void {
  const state: RequestPricingRounds = { accountId, rounds: [] }
  if (c) requestRounds.set(c, state)
  return (usage) => {
    if (!usage) return
    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0
    state.rounds.push({
      promptTokens: Math.max(
        (usage.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens,
        0,
      ),
      completionTokens: usage.outputTokens ?? 0,
      cacheReadTokens,
      cacheWriteTokens,
    })
  }
}

export function takeUsagePricingRounds(
  c: Context,
  accountId: string,
): Array<PricingRound> | undefined {
  const state = requestRounds.get(c)
  requestRounds.delete(c)
  if (state?.accountId !== accountId || state.rounds.length === 0)
    return undefined
  return state.rounds
}
