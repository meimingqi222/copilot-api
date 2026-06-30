/**
 * Per-account concurrency limiter for Windsurf inference requests.
 *
 * Mirrors the Devin CLI's internal "LLM semaphore". Live capture analysis
 * (scripts/capture/concurrency_analysis.txt) shows the CLI peaks at 6
 * simultaneous in-flight GetChatMessage calls (1 main turn + 5 subagents).
 * Default is 8 to match that observed headroom.
 *
 * Stream consumption (reading the response body) does NOT hold the slot —
 * only the initial upstream fetch is gated.
 */

import { logger } from "~/lib/logger"

const DEFAULT_MAX_CONCURRENT = 8

interface WaiterEntry {
  resolve: () => void
  reject: (e: Error) => void
  abortListener?: () => void
  signal?: AbortSignal
}

interface SlotState {
  inFlight: number
  max: number
  waiters: Array<WaiterEntry>
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
    const entry: WaiterEntry = { resolve, reject }
    slot.waiters.push(entry)

    if (signal) {
      if (signal.aborted) {
        removeFromWaiters(slot, entry)
        reject(makeAbortError(signal))
        return
      }
      const abortListener = () => {
        if (removeFromWaiters(slot, entry)) {
          reject(makeAbortError(signal))
        }
      }
      entry.abortListener = abortListener
      entry.signal = signal
      signal.addEventListener("abort", abortListener, { once: true })
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
    // Clean up abort listener before handing off to avoid listener leak
    if (next.signal && next.abortListener) {
      next.signal.removeEventListener("abort", next.abortListener)
    }
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

function removeFromWaiters(slot: SlotState, entry: WaiterEntry): boolean {
  const idx = slot.waiters.indexOf(entry)
  if (idx === -1) return false
  slot.waiters.splice(idx, 1)
  if (entry.signal && entry.abortListener) {
    entry.signal.removeEventListener("abort", entry.abortListener)
  }
  return true
}

function makeAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}
