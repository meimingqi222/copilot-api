import { z } from "zod"

export const redactionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    secrets: z.boolean().default(true),
    homePaths: z.boolean().default(true),
    wordsEnabled: z.boolean().default(true),
    words: z.array(z.string().min(2).max(1024)).max(100).default([]),
    homePrefixes: z.array(z.string().min(2).max(1024)).max(100).default([]),
  })
  .strict()

export type RedactionConfig = z.infer<typeof redactionConfigSchema>

let environmentInput: string | undefined
let environmentConfig: RedactionConfig | undefined

export function environmentRedaction(): RedactionConfig {
  const input = process.env.UPSTREAM_REDACTION
  if (environmentConfig && input === environmentInput) return environmentConfig
  try {
    const config = redactionConfigSchema.parse(input ? JSON.parse(input) : {})
    environmentInput = input
    environmentConfig = config
    return config
  } catch {
    throw new Error("Invalid UPSTREAM_REDACTION configuration")
  }
}

export interface RedactionMatch {
  start: number
  end: number
  kind: "SECRET" | "HOME" | "WORD"
  value: string
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
]

// Matching the complete home prefix avoids replacing usernames in prose.
const HOME_PATTERN =
  /(?:\/home\/[^\s/"'<>:]+|\/Users\/[^\s/"'<>:]+|[A-Za-z]:\\Users\\[^\s\\/"'<>:]+)(?=[/\\\s"'<>]|$)/g
const SECRET_ASSIGNMENT =
  /\b(?:[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*)["']?\s*[:=]\s*["']?([^\s"',;{}]+)/gi
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi

const compiled = new WeakMap<
  RedactionConfig,
  { words: Array<RegExp>; prefixes: Array<RegExp> }
>()

export function findRedactions(
  text: string,
  config: RedactionConfig,
): Array<RedactionMatch> {
  let patterns = compiled.get(config)
  if (!patterns) {
    patterns = {
      words: config.words.map((word) => new RegExp(escapeRegex(word), "g")),
      prefixes: config.homePrefixes.map(
        (prefix) => new RegExp(escapeRegex(prefix), "g"),
      ),
    }
    compiled.set(config, patterns)
  }
  const matches: Array<RedactionMatch> = []
  const add = (start: number, value: string, kind: RedactionMatch["kind"]) => {
    matches.push({ start, end: start + value.length, kind, value })
  }
  if (config.secrets) {
    for (const pattern of SECRET_PATTERNS)
      for (const match of text.matchAll(pattern))
        add(match.index, match[0], "SECRET")
    for (const pattern of [SECRET_ASSIGNMENT, URL_PASSWORD]) {
      for (const match of text.matchAll(pattern)) {
        const value = match[1]
        if (
          value.length >= 8
          && !value.includes("${")
          && /[A-Za-z]/.test(value)
          && /\d/.test(value)
        )
          add(match.index + match[0].lastIndexOf(value), value, "SECRET")
      }
    }
  }
  if (config.homePaths) {
    for (const match of text.matchAll(HOME_PATTERN))
      add(match.index, match[0], "HOME")
    for (const pattern of patterns.prefixes) {
      for (const match of text.matchAll(pattern)) {
        const after = text[match.index + match[0].length]
        if (after === undefined || /[/\\\s"'<>]/.test(after))
          add(match.index, match[0], "HOME")
      }
    }
  }
  if (config.wordsEnabled)
    for (const pattern of patterns.words)
      for (const match of text.matchAll(pattern))
        add(match.index, match[0], "WORD")
  return matches
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
