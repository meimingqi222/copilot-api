import { z } from "zod"

import type {
  PersonalLabel,
  RedactionKind,
  RedactionLabel,
} from "~/lib/redaction/token"

const actionSchema = z.enum(["mask", "warn", "block"])

export const redactionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    secrets: z.boolean().default(true),
    homePaths: z.boolean().default(true),
    wordsEnabled: z.boolean().default(true),
    words: z.array(z.string().min(2).max(1024)).max(100).default([]),
    /** Match `words` in any case: "Nightjar" also masks "NIGHTJAR". */
    wordsAnyCase: z.boolean().default(false),
    homePrefixes: z.array(z.string().min(2).max(1024)).max(100).default([]),
    personal: z.boolean().default(false),
    /** Each personal kind under `personal`. Public IPs appear in nearly every agent request, so they start off. */
    personalKinds: z
      .object({
        EMAIL: z.boolean().default(true),
        PHONE: z.boolean().default(true),
        ID_CARD: z.boolean().default(true),
        BANK_CARD: z.boolean().default(true),
        IP: z.boolean().default(false),
      })
      .strict()
      .prefault({}),
    /** Values sent as written wherever they are found whole. */
    allow: z.array(z.string().min(1).max(1024)).max(200).default([]),
    /** What happens to a value of each category: placeholder, sent as written but counted, or the request is refused. */
    actions: z
      .object({
        SECRET: actionSchema.default("mask"),
        HOME: actionSchema.default("mask"),
        WORD: actionSchema.default("mask"),
        PERSONAL: actionSchema.default("mask"),
      })
      .strict()
      .prefault({}),
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
  kind: RedactionKind
  label: RedactionLabel
  source: "builtin" | "word" | "homePrefix" | "field" | "known"
  value: string
}

export const SECRET_PATTERNS: Array<[RegExp, RedactionLabel]> = [
  [
    /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
    "PRIVATE_KEY",
  ],
  [
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
    "API_KEY",
  ],
  [
    /(?<![\w-])(?:AIza[A-Za-z0-9_-]{35}|ASIA[A-Z0-9]{16}|xai-[A-Za-z0-9]{40,}|hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|[sr]k_live_[A-Za-z0-9]{20,})(?![\w-])/g,
    "API_KEY",
  ],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "TOKEN"],
]

// Tool output may itself contain JSON text, so Windows separators can be
// escaped more than once. Keep that spelling intact for exact restoration.
// Matching the complete home prefix avoids replacing usernames in prose.
const HOME_PATTERN =
  /(?:[A-Za-z]:(?:\/|\\+)[Uu][Ss][Ee][Rr][Ss](?:\/|\\+)|\/home\/|\/Users\/)(?:[^\s\\/"'<>:]+(?:[ \t]+[^\s\\/"'<>:]+)*(?=[/\\"'<>]|$)|[^\s\\/"'<>:]+(?=\s))/g
const SECRET_ASSIGNMENT =
  /\b(?:[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*)["']?\s*[:=]\s*["']?([^\s"',;{}]+)/gi
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi

const PERSONAL_PATTERNS: Array<
  [PersonalLabel, RegExp, ((value: string) => boolean)?]
> = [
  [
    "EMAIL",
    /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g,
  ],
  // Mainland China mobile numbers, with or without +86.
  ["PHONE", /(?<![\d+])(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g],
  [
    "ID_CARD",
    /(?<![\dA-Za-z])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g,
    idCardChecksum,
  ],
  // Card networks start with 3-6; a checksum keeps timestamps and ids out.
  [
    "BANK_CARD",
    /(?<![\d-])[3-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{4,7}(?![\d-])/g,
    luhn,
  ],
  [
    "IP",
    /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g,
    publicIpv4,
  ],
]

export function idCardChecksum(value: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const sum = weights.reduce(
    (total, weight, i) => total + weight * +value[i],
    0,
  )
  return "10X98765432"[sum % 11] === value[17].toUpperCase()
}

export function luhn(value: string): boolean {
  const digits = value.replaceAll(/\D/g, "")
  if (digits.length < 16 || digits.length > 19) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let digit = +digits[digits.length - 1 - i]
    if (i % 2) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

function publicIpv4(value: string): boolean {
  const [a, b] = value.split(".").map(Number)
  return !(
    a === 0
    || a === 10
    || a === 127
    || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
  )
}

const compiled = new WeakMap<
  RedactionConfig,
  { words: Array<RegExp>; prefixes: Array<RegExp>; allow: Set<string> }
>()

function compile(config: RedactionConfig) {
  let patterns = compiled.get(config)
  if (!patterns) {
    patterns = {
      words: config.words.map(
        (word) =>
          new RegExp(escapeRegex(word), config.wordsAnyCase ? "gi" : "g"),
      ),
      prefixes: config.homePrefixes.map(
        (prefix) => new RegExp(escapeRegex(prefix), "g"),
      ),
      allow: new Set(config.allow),
    }
    compiled.set(config, patterns)
  }
  return patterns
}

export function isAllowed(config: RedactionConfig, value: string): boolean {
  return compile(config).allow.has(value)
}

/** Whether a category is switched on; a label further needs its personal kind. */
export function categoryEnabled(
  config: RedactionConfig,
  kind: RedactionKind,
  label?: RedactionLabel,
): boolean {
  switch (kind) {
    case "SECRET": {
      return config.secrets
    }
    case "HOME": {
      return config.homePaths
    }
    case "WORD": {
      return config.wordsEnabled
    }
    case "PERSONAL": {
      return (
        config.personal
        && (!label || config.personalKinds[label as PersonalLabel] === true)
      )
    }
  }
}

export function findRedactions(
  text: string,
  config: RedactionConfig,
): Array<RedactionMatch> {
  const patterns = compile(config)
  const matches: Array<RedactionMatch> = []
  const add = (
    start: number,
    value: string,
    kind: RedactionKind,
    label: RedactionLabel,
    source: RedactionMatch["source"] = "builtin",
  ) => {
    if (patterns.allow.has(value)) return
    matches.push({
      start,
      end: start + value.length,
      kind,
      label,
      source,
      value,
    })
  }
  if (config.secrets) {
    for (const [pattern, label] of SECRET_PATTERNS)
      for (const match of text.matchAll(pattern))
        add(match.index, match[0], "SECRET", label)
    for (const pattern of [SECRET_ASSIGNMENT, URL_PASSWORD]) {
      for (const match of text.matchAll(pattern)) {
        const value = match[1]
        const start = match.index + match[0].lastIndexOf(value)
        if (
          value.length >= 8
          && !value.includes("${")
          && /[A-Za-z]/.test(value)
          && /\d/.test(value)
          && (pattern !== SECRET_ASSIGNMENT
            || !isCodeReference(text, start, value))
        )
          add(start, value, "SECRET", "SECRET")
      }
    }
  }
  if (config.homePaths) {
    for (const match of text.matchAll(HOME_PATTERN))
      add(match.index, match[0], "HOME", "HOME")
    for (const pattern of patterns.prefixes) {
      for (const match of text.matchAll(pattern)) {
        const after = text[match.index + match[0].length]
        if (after === undefined || /[/\\\s"'<>]/.test(after))
          add(match.index, match[0], "HOME", "HOME", "homePrefix")
      }
    }
  }
  if (config.personal)
    for (const [label, pattern, valid] of PERSONAL_PATTERNS) {
      if (!config.personalKinds[label]) continue
      for (const match of text.matchAll(pattern))
        if (!valid || valid(match[0]))
          add(match.index, match[0], "PERSONAL", label)
    }
  if (config.wordsEnabled)
    for (const pattern of patterns.words)
      for (const match of text.matchAll(pattern))
        add(match.index, match[0], "WORD", "WORD", "word")
  return matches
}

/** Unquoted calls and colon-delimited types/field reads name secrets, not their values. */
function isCodeReference(text: string, start: number, value: string): boolean {
  if (text[start - 1] === '"' || text[start - 1] === "'") return false
  const identifier = value.match(
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/,
  )?.[0]
  if (!identifier) return false
  const rest = text.slice(start + identifier.length).trimStart()
  if (rest.startsWith("(")) return true
  return (
    identifier === value
    && text.slice(0, start).trimEnd().endsWith(":")
    && /^[;,)}\]|?&<>]/.test(rest)
  )
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}
