/**
 * Value-level redaction for system logs and diagnostic bundles.
 *
 * The logger already blanks fields by name (`token`, `password`, …), but a
 * secret also travels inside values: a URL's `?key=…`, an error message that
 * quotes an `Authorization: Bearer …` header, a stack frame holding a key.
 * Name-based redaction lets all of those through, so every string written to
 * a system log or a bundle also passes through `redactText`.
 */

import { SECRET_PATTERNS } from "~/lib/redaction/rules"

const MASK = "[redacted]"

/** Query parameters whose value is a credential. */
const SECRET_QUERY =
  /([?&](?:[\w.-]*(?:key|token|secret|sig|signature|password|passwd|auth|credential|session|code)[\w.-]*)=)[^&#\s"'<>]*/gi

const BEARER = /\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi

const HEADER_VALUE =
  /\b((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)\s*[:=]\s*)[^\r\n,;]+/gi

/** `user:password@host` in a URL. */
const URL_PASSWORD = /(\b[a-z][\w+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi

/** Masks credentials found in a free-form string. */
export function redactText(text: string): string {
  let out = text
    .replaceAll(SECRET_QUERY, `$1${MASK}`)
    .replaceAll(BEARER, `$1 ${MASK}`)
    .replaceAll(HEADER_VALUE, `$1${MASK}`)
    .replaceAll(URL_PASSWORD, `$1${MASK}@`)
  for (const [pattern] of SECRET_PATTERNS) out = out.replaceAll(pattern, MASK)
  return out
}

/** How many credential-shaped values `redactText` would mask. */
export function countRedactions(text: string): number {
  let count = 0
  for (const pattern of [SECRET_QUERY, BEARER, HEADER_VALUE, URL_PASSWORD])
    count += [...text.matchAll(pattern)].length
  for (const [pattern] of SECRET_PATTERNS)
    count += [...text.matchAll(pattern)].length
  return count
}

// Not "credential": credentialId and a connection's credentials list are ids
// and statuses, and must stay readable.
const KEY_RE =
  /authorization|api[-_]?key|password|passwd|secret|cookie|private[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|^token$|bearer/i

/** Field names whose whole value is a credential. */
export function isSecretKey(key: string): boolean {
  return KEY_RE.test(key)
}

/**
 * Deep copy with secret-named fields blanked and every string passed through
 * `redactText`. Depth and breadth are bounded so a huge object cannot stall
 * the logger.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value)
  if (value === null || typeof value !== "object") return value
  if (depth > 8) return "[depth limit]"
  if (Array.isArray(value))
    return value.slice(0, 200).map((item) => redactValue(item, depth + 1))
  if (value instanceof Error) return redactText(String(value))
  const out: Record<string, unknown> = {}
  let count = 0
  for (const [key, nested] of Object.entries(value)) {
    if (++count > 200) break
    out[key] = isSecretKey(key) ? MASK : redactValue(nested, depth + 1)
  }
  return out
}
