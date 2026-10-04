const REDACTED = "[redacted]"
const MAX_DEPTH = 64

/** Match credentials without confusing token counters or ordinary metadata. */
export function isDumpSecretField(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  return /authorization$|cookie$|password$|passwd$|token$|apikey$|authkey$|subscriptionkey$|accesskey(?:id)?$|secret$|secretkey$|privatekey$|credentials?$|^x(?:amz|goog)signature$/.test(
    normalized,
  )
}

function isMediaField(key: string, record: Record<string, unknown>): boolean {
  return (
    /^(base64|file_data|audio_data|inline_?data|input_audio)$/i.test(key)
    || (key === "data"
      && (record.type === "base64" || record.encoding === "base64"))
  )
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown
  } catch {
    return undefined
  }
}

/** One scope shares known secrets between headers, body and error echoes. */
export function createDumpSanitizer(inputs: ReadonlyArray<string>) {
  const secrets = new Set<string>()
  function remember(value: unknown, depth = 0): void {
    if (depth > MAX_DEPTH) return
    if (typeof value === "string") {
      const parsed = parseJson(value)
      if (parsed !== undefined) remember(parsed, depth + 1)
    } else if (Array.isArray(value)) {
      for (const item of value) remember(item, depth + 1)
    } else if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        if (
          isDumpSecretField(key)
          && typeof nested === "string"
          && nested.length >= 4
        ) {
          secrets.add(nested)
          const token = nested.replace(/^(Bearer|Basic|Cloud-IDE-JWT)\s+/i, "")
          if (token.length >= 4) secrets.add(token)
          if (/cookie$/i.test(key)) {
            for (const cookie of nested.split(";")) {
              const value = cookie.slice(cookie.indexOf("=") + 1).trim()
              if (value.length >= 4) secrets.add(value)
            }
          }
        }
        remember(nested, depth + 1)
      }
    }
  }
  for (const input of inputs) remember(parseJson(input))
  const knownSecrets = [...secrets].sort((a, b) => b.length - a.length)

  function text(input: string, depth = 0): string {
    if (depth > MAX_DEPTH) return "[omitted: nesting limit]"
    let result = input
    for (const secret of knownSecrets)
      result = result.replaceAll(secret, REDACTED)
    return result
      .replaceAll(
        /\b(Bearer|Basic|Cloud-IDE-JWT)\s+[^\s,;"'<>]+/gi,
        "$1 [redacted]",
      )
      .replaceAll(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        REDACTED,
      )
      .replaceAll(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
        REDACTED,
      )
      .replaceAll(
        /\b([a-z][a-z0-9_-]*)(["']?\s*[=:]\s*)("[^"\n]*(?:"|$)|'[^'\n]*(?:'|$)|[^\s,;&"'<>]+)/gi,
        (_match: string, key: string, separator: string, value: string) =>
          isDumpSecretField(key) ?
            `${key}${separator}${REDACTED}`
          : `${key}${separator}${text(value, depth + 1)}`,
      )
      .replaceAll(/\b((?:set-)?cookie\s*[:=]\s*)[^\r\n]*/gi, "$1[redacted]")
      .replaceAll(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
        REDACTED,
      )
      .replaceAll(
        /data:[^\s,;"'<>]+(?:;[^,\s"'<>]*)?,[^\s"'<>]+/gi,
        "[redacted media]",
      )
      .replaceAll(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
      .replaceAll(/([?&]key=)[^&\s"'<>]+/gi, "$1[redacted]")
  }

  function sanitize(value: unknown, depth = 0): unknown {
    if (depth > MAX_DEPTH) return "[omitted: nesting limit]"
    if (typeof value === "string") {
      const parsed = parseJson(value)
      return parsed === undefined ?
          text(value)
        : JSON.stringify(sanitize(parsed, depth + 1))
    }
    if (Array.isArray(value))
      return value.map((item) => sanitize(item, depth + 1))
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      return Object.fromEntries(
        Object.entries(record).map(([key, nested]) => [
          key,
          isDumpSecretField(key) || isMediaField(key, record) ?
            REDACTED
          : sanitize(nested, depth + 1),
        ]),
      )
    }
    return value
  }

  function json(input: string): string {
    const parsed = parseJson(input)
    return parsed === undefined ?
        "[body omitted: invalid JSON]"
      : JSON.stringify(sanitize(parsed))
  }

  function error(input: string): string {
    const parsed = parseJson(input)
    return parsed === undefined ? text(input) : JSON.stringify(sanitize(parsed))
  }

  return { json, error, text }
}
