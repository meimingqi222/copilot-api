/**
 * Shared helpers for the balance readers: number coercion, currency signs,
 * money formatting, and dotted-path reads for a user-configured `BalancePath`.
 */

/** Coerce a finite number or a numeric string to a number. */
export function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Currency symbol used by the money formatters. */
export function currencySign(code: string): string {
  const normalized = code.trim().toUpperCase()
  if (normalized === "CNY" || normalized === "RMB") return "¥"
  if (normalized === "USD") return "$"
  if (!normalized) return ""
  return `${normalized} `
}

/** Format `sign + amount` with two decimals, e.g. money("¥", 12.34). */
export function money(sign: string, amount: number): string {
  return `${sign}${amount.toFixed(2)}`
}

/**
 * Read a dotted path off a parsed JSON root.
 *
 * Accepts `$data.a.b`, `data.a.b` or `a.b`; a leading `$` is the response
 * root. Numeric segments index into arrays. Returns undefined on any miss.
 */
export function readDottedPath(root: unknown, path: string): unknown {
  if (!path) return undefined
  const segments = path
    .replace(/^\$/, "")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  let current: unknown = root
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined
      }
      current = current[index]
      continue
    }
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment]
      continue
    }
    return undefined
  }
  return current
}
