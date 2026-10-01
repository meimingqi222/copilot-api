/**
 * Local-time windows.
 *
 * A window is `from`–`to` plus an optional day list, all in the server's local
 * time. Two shapes need care:
 *
 * - `from === to` is not an empty window, it is the whole day: writing
 *   `00:00`–`00:00` is how a caller says "any time, but only on these days".
 * - `from > to` crosses midnight. The window belongs to the day it *opens* on:
 *   a Friday 22:00–08:00 window covers Saturday's small hours too, and those
 *   hours are attributed to Friday when the day list is checked. Otherwise a
 *   weekday-evening window could never cover its own tail on a listed day.
 *
 * Everything is half-open: `to` itself is outside the window.
 */

import type { TimeWindow } from "./types"

/** Day names in display order (Monday first, the way a week is written). */
export const DAY_NAMES = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const

type DayName = (typeof DAY_NAMES)[number]

/** Day names in `Date.getDay()` order, for weekday arithmetic. */
const JS_DAY_ORDER: Array<DayName> = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
]

const DAY_LABELS: Record<DayName, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
}

/** Short and long spellings, all accepted. */
const DAY_ALIASES: Record<string, DayName> = {
  mon: "mon",
  monday: "mon",
  tue: "tue",
  tues: "tue",
  tuesday: "tue",
  wed: "wed",
  weds: "wed",
  wednesday: "wed",
  thu: "thu",
  thur: "thu",
  thurs: "thu",
  thursday: "thu",
  fri: "fri",
  friday: "fri",
  sat: "sat",
  saturday: "sat",
  sun: "sun",
  sunday: "sun",
}

/** A window with its text fields already parsed. */
interface NormalizedWindow {
  /** Minutes since local midnight the window opens. */
  from: number
  /** Minutes since local midnight the window closes (exclusive). */
  to: number
  /** Attributed days; absent means every day. */
  days?: Array<DayName>
  /** `from === to`: the whole attributed day. */
  wholeDay: boolean
}

export class TimeWindowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TimeWindowError"
  }
}

/** "HH:MM" or "H:MM" → minutes since midnight; undefined when unparsable. */
export function parseTime(value: string): number | undefined {
  if (typeof value !== "string") return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/** "mon" / "Monday" (any case) → the canonical three-letter name. */
export function parseDay(value: string): DayName | undefined {
  if (typeof value !== "string") return undefined
  const key = value.trim().toLowerCase().replace(/\.$/, "")
  return DAY_ALIASES[key]
}

/** Parse a window, throwing {@link TimeWindowError} on unusable input. */
export function normalizeWindow(window: TimeWindow): NormalizedWindow {
  if (typeof window !== "object" || window === null) {
    throw new TimeWindowError("Time window must be an object")
  }

  const from = parseTime(window.from)
  const to = parseTime(window.to)
  if (from === undefined) {
    throw new TimeWindowError(`Invalid window start: ${String(window.from)}`)
  }
  if (to === undefined) {
    throw new TimeWindowError(`Invalid window end: ${String(window.to)}`)
  }

  const normalized: NormalizedWindow = { from, to, wholeDay: from === to }

  if (window.days !== undefined) {
    if (!Array.isArray(window.days)) {
      throw new TimeWindowError("Time window days must be an array")
    }
    const days: Array<DayName> = []
    for (const raw of window.days) {
      const day = parseDay(raw)
      if (!day) throw new TimeWindowError(`Invalid window day: ${String(raw)}`)
      if (!days.includes(day)) days.push(day)
    }
    // An empty day list can never hold. Reading it as "every day" instead
    // would turn a typo into a window that quietly applies always.
    if (days.length === 0) {
      throw new TimeWindowError("Time window days must not be empty")
    }
    normalized.days = days
  }

  return normalized
}

function minutesOfDay(at: Date): number {
  return at.getHours() * 60 + at.getMinutes()
}

function dayOf(at: Date): DayName {
  return JS_DAY_ORDER[at.getDay()] ?? "mon"
}

function dayBefore(day: DayName): DayName {
  const index = JS_DAY_ORDER.indexOf(day)
  return (
    JS_DAY_ORDER[(index + JS_DAY_ORDER.length - 1) % JS_DAY_ORDER.length]
    ?? "mon"
  )
}

function dayAllowed(window: NormalizedWindow, day: DayName): boolean {
  return window.days === undefined || window.days.includes(day)
}

/** Whether `window` is open at `at` (local time). Unparsable windows never hold. */
export function holds(window: TimeWindow, at: Date): boolean {
  let normalized: NormalizedWindow
  try {
    normalized = normalizeWindow(window)
  } catch {
    return false
  }

  const minutes = minutesOfDay(at)
  const today = dayOf(at)

  if (normalized.wholeDay) {
    return dayAllowed(normalized, today)
  }

  if (normalized.from < normalized.to) {
    const inside = minutes >= normalized.from && minutes < normalized.to
    return inside && dayAllowed(normalized, today)
  }

  // Crosses midnight: the small hours belong to the day the window opened on.
  if (minutes >= normalized.from) {
    return dayAllowed(normalized, today)
  }
  if (minutes < normalized.to) {
    return dayAllowed(normalized, dayBefore(today))
  }
  return false
}

/** The day list as compact text: "Mon–Fri", "Sat–Mon", "Every day". */
export function daysText(window: TimeWindow): string {
  let normalized: NormalizedWindow
  try {
    normalized = normalizeWindow(window)
  } catch {
    return "Every day"
  }
  const days = normalized.days
  if (!days || days.length === DAY_NAMES.length) return "Every day"

  const ordered = DAY_NAMES.filter((day) => days.includes(day))
  const runs: Array<Array<DayName>> = []
  for (const day of ordered) {
    const current = runs.at(-1)
    const previous = current?.at(-1)
    const consecutive =
      previous !== undefined
      && JS_DAY_ORDER.indexOf(day) === (JS_DAY_ORDER.indexOf(previous) + 1) % 7
    if (current && consecutive) {
      current.push(day)
    } else {
      runs.push([day])
    }
  }

  // A run that starts on Monday continues the one that ended on Sunday.
  const first = runs.at(0)
  const last = runs.at(-1)
  if (
    runs.length > 1
    && first !== last
    && first?.at(0) === "mon"
    && last?.at(-1) === "sun"
  ) {
    runs[0] = [...(last ?? []), ...(first ?? [])]
    runs.pop()
  }

  return runs
    .map((run) => {
      const head = run.at(0)
      const tail = run.at(-1)
      if (!head || !tail) return ""
      if (run.length === 1) return DAY_LABELS[head]
      return `${DAY_LABELS[head]}–${DAY_LABELS[tail]}`
    })
    .filter((text) => text !== "")
    .join(", ")
}

/** Canonical text for a window: "Mon–Fri 22:00–08:00". */
export function windowText(window: TimeWindow): string {
  const normalized = normalizeWindow(window)
  const range =
    normalized.wholeDay ? "All day" : (
      `${formatTime(normalized.from)}–${formatTime(normalized.to)}`
    )
  return `${daysText(window)} ${range}`
}

function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}
