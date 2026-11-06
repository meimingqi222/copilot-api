import type { PlanAllowance, PlanWindow } from "./types"
import { quotaWindowApplies } from "~/lib/quota/allowance"

/**
 * Advance windows to `now`: a window whose `resetsAtMs` has already passed is
 * empty again, so its `used` share resets and its reset instant is cleared.
 * Windows that have not renewed (or carry no reset instant) are returned as-is.
 */
export function elapsed(windows: PlanAllowance, now: number): PlanAllowance {
  return windows.map((window) => {
    if (window.expiresAtMs !== undefined && window.expiresAtMs <= now) {
      return { ...window, used: 1, remaining: 0 }
    }
    if (window.resetsAtMs === undefined || window.resetsAtMs > now) {
      return window
    }
    return {
      ...window,
      used: window.used === undefined ? undefined : 0,
      remaining: window.total,
      resetsAtMs: undefined,
    }
  })
}

/**
 * Does a window count this model?
 *
 * Typed scopes match exact native IDs, and an empty scope matches nothing.
 * Only persisted legacy `model` scopes use case-insensitive substring matching.
 */
export function windowApplies(window: PlanWindow, model?: string): boolean {
  return quotaWindowApplies(window, model)
}

/**
 * The fullest applying window's used share, plus the renewal instants of the
 * applying windows ordered biggest-window-first (spanMs desc, then resetsAtMs
 * desc), so callers can report the longest horizon that is about to reset.
 *
 * Windows marked `aside` are not filtered here; routing callers drop them.
 */
export function allowanceFor(
  windows: PlanAllowance,
  model: string | undefined,
  now: number,
): { used: number | undefined; renews: Array<number> } {
  const applying = elapsed(windows, now).filter((window) =>
    windowApplies(window, model),
  )

  const fractions = applying.flatMap((window) =>
    window.unlimited ? [0]
    : window.used === undefined ? []
    : [window.used],
  )
  const used = fractions.length ? Math.max(...fractions) : undefined

  const renews = applying
    .filter(
      (window): window is PlanWindow & { resetsAtMs: number } =>
        window.resetsAtMs !== undefined,
    )
    .sort(
      (a, b) =>
        (b.spanMs ?? 0) - (a.spanMs ?? 0) || b.resetsAtMs - a.resetsAtMs,
    )
    .map((window) => window.resetsAtMs)

  return { used, renews }
}

/**
 * The latest renewal instant among applying windows that have already used at
 * least `share` of their allowance, or undefined when no applying window has.
 */
export function allowanceFullAt(
  windows: PlanAllowance,
  model: string | undefined,
  share: number,
  now: number,
): number | undefined {
  let latest: number | undefined
  for (const window of elapsed(windows, now)) {
    if (
      !windowApplies(window, model)
      || window.used === undefined
      || window.used < share
    ) {
      continue
    }
    if (window.resetsAtMs === undefined) {
      continue
    }
    latest =
      latest === undefined ?
        window.resetsAtMs
      : Math.max(latest, window.resetsAtMs)
  }
  return latest
}
