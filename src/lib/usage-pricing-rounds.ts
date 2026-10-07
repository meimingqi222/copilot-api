import type { Context } from "hono"

import type { IRUsage } from "~/services/ir/types"

import { logger } from "~/lib/logger"
import { getRequestLogContext } from "~/lib/request-log"

interface PricingRound {
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface RequestPricingRounds {
  accountId: string
  requestId: string | undefined
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
  const state: RequestPricingRounds = {
    accountId,
    requestId: c ? getRequestLogContext(c)?.requestId : undefined,
    rounds: [],
  }
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
  if (!state) return undefined
  if (state.requestId !== getRequestLogContext(c)?.requestId) return undefined
  if (state.accountId !== accountId) {
    logger.debug("Discarding usage pricing rounds for a different account", {
      recordedAccountId: state.accountId,
      accountId,
    })
    return undefined
  }
  if (state.rounds.length === 0) return undefined
  return state.rounds
}
