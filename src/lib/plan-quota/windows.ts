import type { PlanAllowance, PlanWindow } from "./types"

/**
 * Advance windows to `now`: a window whose `resetsAtMs` has already passed is
 * empty again, so its `used` share resets and its reset instant is cleared.
 * Windows that have not renewed (or carry no reset instant) are returned as-is.
 */
export function elapsed(windows: PlanAllowance, now: number): PlanAllowance {
  return windows.map((window) => {
    if (window.resetsAtMs === undefined || window.resetsAtMs > now) {
      return window
    }
    return { ...window, used: 0, resetsAtMs: undefined }
  })
}

/**
 * Does a window count this model?
 *
 * A window with no `model` counts every model. A scoped window only counts a
 * model whose id contains that word (case-insensitive). Omitting the model
 * argument asks "could any model apply", so every window answers true.
 */
export function windowApplies(window: PlanWindow, model?: string): boolean {
  const scope = window.model?.trim().toLowerCase()
  if (!scope) {
    return true
  }
  if (!model) {
    return true
  }
  return model.toLowerCase().includes(scope)
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
): { used: number; renews: Array<number> } {
  const applying = elapsed(windows, now).filter((window) =>
    windowApplies(window, model),
  )

  const used = applying.reduce(
    (fullest, window) => Math.max(fullest, window.used),
    0,
  )

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
    if (!windowApplies(window, model) || window.used < share) {
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
