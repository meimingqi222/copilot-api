export const REDACT_FIELD_RE =
  /authorization|api[-_]?key|password|token|secret|cookie|session|image|base64|data/i

const REDACTED_VALUE = "[redacted]"

export function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        REDACT_FIELD_RE.test(key) ? REDACTED_VALUE : sanitizeJson(nested),
      ]),
    )
  }
  return value
}

export function sanitizeDiagnosticSnippet(
  input: string | undefined,
  maxLength = 512,
): string | undefined {
  if (!input) return undefined
  let sanitized: string
  try {
    sanitized = JSON.stringify(sanitizeJson(JSON.parse(input) as unknown))
  } catch {
    sanitized = input
      .replaceAll(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
      .replaceAll(
        /\b(authorization|api[-_]?key|password|token|secret|cookie|session|image|base64|data)(\s*[=:]\s*)[^\s,;&]+/gi,
        "$1$2[redacted]",
      )
  }
  return sanitized.slice(0, maxLength)
}
