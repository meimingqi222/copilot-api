/**
 * Per-account concurrency limiter for Windsurf inference requests.
 *
 * Mirrors the Devin CLI's internal "LLM semaphore" (confirmed via binary
 * analysis: `Failed to acquire LLM semaphore` + tokio `semaphore.rs`). The
 * CLI is interactive so typically only one inference is in flight at a time;
 * copilot-api can fan out concurrent requests from multiple clients, which
 * spikes request density and trips Windsurf's per-model message-rate quota.
 *
 * This gate caps concurrent in-flight fetches per account. Default is 1
 * (matching CLI behavior). Stream consumption (reading the response body)
 * does NOT hold the slot — only the initial upstream fetch is gated.
 */

import { logger } from "~/lib/logger"

const DEFAULT_MAX_CONCURRENT = 1

interface SlotState {
  inFlight: number
  max: number
  waiters: Array<{ resolve: () => void; reject: (e: Error) => void }>
}

const slots = new Map<string, SlotState>()

function getSlot(accountId: string): SlotState {
  let slot = slots.get(accountId)
  if (!slot) {
    slot = { inFlight: 0, max: DEFAULT_MAX_CONCURRENT, waiters: [] }
    slots.set(accountId, slot)
  }
  return slot
}

/**
 * Acquire a concurrency slot for the given account, waiting if the account
 * is already at its concurrency cap. Rejects if the abort signal fires
 * while waiting.
 */
export function acquireWindsurfSlot(
  accountId: string,
  signal?: AbortSignal,
): Promise<void> {
  const slot = getSlot(accountId)
  if (slot.inFlight < slot.max) {
    slot.inFlight += 1
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    const entry = { resolve, reject }
    slot.waiters.push(entry)

    if (signal) {
      if (signal.aborted) {
        removeFromWaiters(slot, entry)
        reject(makeAbortError(signal))
        return
      }
      signal.addEventListener(
        "abort",
        () => {
          if (removeFromWaiters(slot, entry)) {
            reject(makeAbortError(signal))
          }
        },
        { once: true },
      )
    }
  })
}

/**
 * Release a slot, waking the next waiter (FIFO) if any.
 */
export function releaseWindsurfSlot(accountId: string): void {
  const slot = slots.get(accountId)
  if (!slot) {
    logger.warn(
      `[windsurf] releaseWindsurfSlot: no slot for account ${accountId}`,
    )
    return
  }

  const next = slot.waiters.shift()
  if (next) {
    // Hand off directly — inFlight stays the same
    next.resolve()
    return
  }
  slot.inFlight = Math.max(0, slot.inFlight - 1)
}

/** Current in-flight count for diagnostics. */
export function getWindsurfConcurrency(accountId: string): number {
  return slots.get(accountId)?.inFlight ?? 0
}

/** Test hook: reset all slots. */
export function resetWindsurfSlotsForTest(): void {
  for (const slot of slots.values()) {
    for (const w of slot.waiters) {
      w.reject(new Error("test reset"))
    }
  }
  slots.clear()
}

function removeFromWaiters(
  slot: SlotState,
  entry: { resolve: () => void; reject: (e: Error) => void },
): boolean {
  const idx = slot.waiters.indexOf(entry)
  if (idx === -1) return false
  slot.waiters.splice(idx, 1)
  return true
}

function makeAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}
