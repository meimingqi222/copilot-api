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
export interface PlanWindow {
  /** Share of the window already spent, 0..1. */
  used: number
  /** Full length of the window in ms; the longest applying window wins. */
  spanMs?: number
  /** Instant the window renews. A passed instant makes the window empty again. */
  resetsAtMs?: number
  /** A word the window counts (e.g. "opus"). Empty/undefined counts every model. */
  model?: string
  /** Routing ignores windows marked aside. */
  aside?: boolean
}

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
