/**
 * Viewer-timezone helpers for stats display.
 *
 * Usage rows are written with a server-local `date` plus an exact UTC
 * `timestamp`. Day boundaries for display must follow the *viewer's* timezone
 * (the browser), otherwise a server in another timezone shows shifted days.
 * All grouping/filtering here keys off `timestamp`, never the `date` column.
 */

const dayFormatterCache = new Map<string, Intl.DateTimeFormat>()

function dayFormatter(tz: string): Intl.DateTimeFormat {
  let formatter = dayFormatterCache.get(tz)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    dayFormatterCache.set(tz, formatter)
  }
  return formatter
}

/** Validate an IANA timezone name; fall back to the server timezone. */
export function resolveTimeZone(tz?: string | null): string {
  if (tz && typeof tz === "string" && tz.trim()) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz.trim() })
      return tz.trim()
    } catch {
      // Invalid IANA name — fall through to the server timezone.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** YYYY-MM-DD of the instant in the given timezone. */
export function formatDateInTimeZone(timestamp: number, tz: string): string {
  return dayFormatter(tz).format(new Date(timestamp))
}

/** UTC offset of the timezone at the instant, in milliseconds. */
export function timeZoneOffsetMs(tz: string, timestamp: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date(timestamp))
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value
      return acc
    }, {})
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return asUTC - Math.floor(timestamp / 1000) * 1000
}

function parseDateParts(dateStr: string): {
  year: number
  month: number
  day: number
} {
  const [year, month, day] = dateStr.split("-").map(Number)
  return { year, month, day }
}

export function formatDateParts(
  year: number,
  month: number,
  day: number,
): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/**
 * UTC milliseconds of 00:00 on the viewer date in the given timezone.
 * Solved by fixed-point iteration on the zone offset so DST transitions
 * inside the day still resolve to the correct midnight (sampling at noon
 * would pick the post-transition offset on spring-forward days).
 */
export function startOfDayMs(dateStr: string, tz: string): number {
  const { year, month, day } = parseDateParts(dateStr)
  const midnightUTC = Date.UTC(year, month - 1, day)
  let start = midnightUTC - timeZoneOffsetMs(tz, midnightUTC + 12 * 3600_000)
  for (let i = 0; i < 3; i += 1) {
    const refined = midnightUTC - timeZoneOffsetMs(tz, start)
    if (refined === start) break
    start = refined
  }
  return start
}

/** Calendar-day arithmetic on a YYYY-MM-DD string (timezone-agnostic). */
export function addDays(dateStr: string, days: number): string {
  const { year, month, day } = parseDateParts(dateStr)
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86400_000)
  return formatDateParts(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  )
}

/** YYYY-MM-DD of "now" in the given timezone. */
export function todayInTimeZone(tz: string, nowMs = Date.now()): string {
  return formatDateInTimeZone(nowMs, tz)
}

/**
 * 0=Sunday..6=Saturday of the viewer date. Computed from the civil date
 * parts (weekday is zone-independent); reading it off the midnight instant
 * would give the UTC weekday instead.
 */
export function weekdayInTimeZone(dateStr: string): number {
  const { year, month, day } = parseDateParts(dateStr)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}
