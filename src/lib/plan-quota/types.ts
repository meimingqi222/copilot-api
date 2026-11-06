/**
 * Plan quota model.
 *
 * A plan reports its allowance as *shares of a rolling window* rather than as
 * absolute request counts. That shape is replayable: a reading taken earlier
 * can still be advanced later (see `~/lib/plan-quota/windows`), which is what
 * lets a transient upstream failure show the last known allowance instead of
 * an error.
 */

/**
 * One allowance window.
 *
 * `used` is the share of the window already spent (0..1). `model` scopes the
 * window to a word it counts — empty/undefined means the window counts every
 * model. `aside` marks a window routing ignores (reporting-only windows).
 */
export type { QuotaWindow as PlanWindow } from "~/lib/quota/types"

import type { QuotaWindow as PlanWindow } from "~/lib/quota/types"

/** Every window an account currently reports. */
export type PlanAllowance = Array<PlanWindow>

/** A stored reading: the windows as read, plus when they were read. */
export interface PlanReading {
  windows: PlanAllowance
  asOf: number
}

/**
 * Result of `mergeWithLast` — a usable allowance plus whether it is a replayed
 * reading rather than a fresh one.
 */
export interface MergedPlanAllowance {
  windows: PlanAllowance
  asOf?: number
  stale: boolean
}
