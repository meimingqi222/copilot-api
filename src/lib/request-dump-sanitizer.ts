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

/**
 * Cheap gate before JSON.parse: only a leading `{`/`[` (after whitespace)
 * can yield a structure worth sanitizing. Most strings in a body are plain
 * text/values; this skips the throwaway parse the old code ran on every one.
 */
function looksLikeJson(input: string): boolean {
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === "{" || ch === "[") return true
    if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") return false
  }
  return false
}

/**
 * Parsed results are memoized per-sanitizer because the same string is
 * walked twice: once collecting secrets (`remember`) and once producing the
 * sanitized copy (`sanitize`). Bounded — embedded JSON strings are rare and
 * an unbounded map would pin large bodies.
 */
const PARSE_MEMO_MAX = 128

function parseJson(input: string, memo?: Map<string, unknown>): unknown {
  if (!looksLikeJson(input)) return undefined
  if (memo?.has(input)) return memo.get(input)
  let parsed: unknown
  try {
    parsed = JSON.parse(input) as unknown
  } catch {
    parsed = undefined
  }
  if (memo) {
    if (memo.size >= PARSE_MEMO_MAX) memo.delete(memo.keys().next().value!)
    memo.set(input, parsed)
  }
  return parsed
}

/** One scope shares known secrets between headers, body and error echoes. */
export type DumpSanitizer = ReturnType<typeof createDumpSanitizer>

export function createDumpSanitizer(inputs: ReadonlyArray<string>) {
  const secrets = new Set<string>()
  const memo = new Map<string, unknown>()
  /**
   * Sorted longest-first so a token containing another secret is replaced as a
   * whole. Built lazily and dropped whenever more secrets arrive, because the
   * header pass runs before the body has been read.
   */
  let knownSecrets: Array<string> | undefined

  function remember(value: unknown, depth = 0): void {
    if (depth > MAX_DEPTH) return
    if (typeof value === "string") {
      const parsed = parseJson(value, memo)
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
          knownSecrets = undefined
        }
        remember(nested, depth + 1)
      }
    }
  }
  /**
   * Add a scope's worth of text to the shared secret pool. Called once per
   * input at construction, and again for the body once it has been read.
   */
  function addSecrets(input: string): void {
    const parsed = parseJson(input, memo)
    if (parsed !== undefined) remember(parsed)
  }

  for (const input of inputs) addSecrets(input)

  function currentSecrets(): ReadonlyArray<string> {
    if (!knownSecrets)
      knownSecrets = [...secrets].sort((a, b) => b.length - a.length)
    return knownSecrets
  }

  function text(input: string, depth = 0): string {
    if (depth > MAX_DEPTH) return "[omitted: nesting limit]"
    let result = input
    for (const secret of currentSecrets())
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
      const parsed = parseJson(value, memo)
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
    const parsed = parseJson(input, memo)
    return parsed === undefined ?
        "[body omitted: invalid JSON]"
      : JSON.stringify(sanitize(parsed))
  }

  function error(input: string): string {
    const parsed = parseJson(input, memo)
    return parsed === undefined ? text(input) : JSON.stringify(sanitize(parsed))
  }

  return { json, error, text, addSecrets }
}
