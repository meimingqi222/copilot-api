import { isIPv6 } from "node:net"
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
        SSN: z.boolean().default(false),
        PASSPORT: z.boolean().default(false),
        IBAN: z.boolean().default(false),
        BIRTHDAY: z.boolean().default(false),
        MAC: z.boolean().default(false),
        SERIAL: z.boolean().default(false),
        USERNAME: z.boolean().default(false),
        HOSTNAME: z.boolean().default(false),
        BUCKET: z.boolean().default(false),
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

export const SECRET_PATTERNS: Array<[RegExp, RedactionLabel, Array<string>?]> =
  [
    [
      /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
      "PRIVATE_KEY",
      ["-----BEGIN "],
    ],
    [/[a-z]{2,4}_sk_[A-Za-z0-9_-]{20,}/g, "API_KEY", ["_sk_"]],
    [
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
      "API_KEY",
      [
        "sk-",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "glpat-",
        "AKIA",
        "xoxa-",
        "xoxb-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
      ],
    ],
    [
      /(?<![\w-])(?:AIza[A-Za-z0-9_-]{35}|ASIA[A-Z0-9]{16}|xai-[A-Za-z0-9]{40,}|hf_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{40,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}|[sr]k_live_[A-Za-z0-9]{20,})(?![\w-])/g,
      "API_KEY",
      [
        "AIza",
        "ASIA",
        "xai-",
        "hf_",
        "gsk_",
        "npm_",
        "pypi-",
        "dop_v1_",
        "SG.",
        "rk_live_",
        "sk_live_",
      ],
    ],
    [
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "TOKEN",
      ["eyJ"],
    ],
  ]

// Tool output may itself contain JSON text, so Windows separators can be
// escaped more than once. Keep that spelling intact for exact restoration.
// Matching the complete home prefix avoids replacing usernames in prose.
const HOME_PATTERN =
  /(?:[A-Za-z]:(?:\/|\\+)[Uu][Ss][Ee][Rr][Ss](?:\/|\\+)|\/home\/|\/Users\/)(?:[^\s\\/"'<>:]+(?:[ \t]+[^\s\\/"'<>:]+)*(?=[/\\"'<>]|$)|[^\s\\/"'<>:]+(?=\s))/g
const SECRET_ASSIGNMENT =
  /\b(?:[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[\w-]*)["']?\s*[:=]\s*["']?([^\s"',;{}]+)/gi

/** Any assignment match names one of these; skip the regex on text that names none. */
const SECRET_ASSIGNMENT_HINT =
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi

const IBAN_LENGTHS: Record<string, number> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SC: 31,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
}

function isSSN(value: string) {
  const digits = value.match(/\d/g)?.join("") ?? ""
  if (digits.length !== 9) return false
  if (/^(\d)\1{8}$/.test(digits)) return false
  if (/^(?:0{3}|666)\d{6}$/.test(digits)) return false
  const group = digits.slice(3, 5)
  return group !== "00"
}

function isPassport(value: string) {
  const compact = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase()
  if (compact.length < 5 || compact.length > 9) return false
  if (!/\d/.test(compact)) return false
  if (compact.length >= 6 && /^(.)\1+$/.test(compact)) return false
  return true
}

function isIBAN(value: string) {
  const compact = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase()
  if (compact.length < 15 || compact.length > 34) return false
  const country = compact.slice(0, 2)
  if (!(country in IBAN_LENGTHS)) return false
  if (compact.length !== IBAN_LENGTHS[country]) return false
  const rearranged = compact.slice(4) + compact.slice(0, 4)
  let remainder = 0
  for (const character of rearranged) {
    const code = character.charCodeAt(0)
    const digits = code >= 65 && code <= 90 ? (code - 55).toString() : character
    for (const digit of digits)
      remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

function isBirthday(value: string) {
  const numbers = value.match(/\d+/g)?.map(Number) ?? []
  const valid = (year: number, month: number, day: number) => {
    if (year < 1900 || year > 2099 || month < 1 || month > 12) return false
    if (day < 1 || day > 31) return false
    if (month === 2 && day > 29) return false
    if ([4, 6, 9, 11].includes(month) && day > 30) return false
    return true
  }

  if (numbers.length === 3) {
    const [first, second, third] = numbers
    if (first >= 1900 && first <= 2099) return valid(first, second, third)
    if (third >= 1900 && third <= 2099)
      return valid(third, first, second) || valid(third, second, first)
    return false
  }

  if (numbers.length === 2) {
    const month = value.match(
      /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i,
    )
    if (month === null) return false
    const index =
      [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ].indexOf(month[0].toLowerCase()) + 1
    const [day, year] = numbers
    return valid(year, index, day)
  }

  return false
}

function isMAC(value: string) {
  const compact = value.replace(/[:-]/g, "").toUpperCase()
  if (compact.length !== 12) return false
  return ![
    "FFFFFFFFFFFF",
    "000000000000",
    "AABBCCDDEEFF",
    "E0E0E0E0E0E0",
    "E0E0E0E0E0E1",
  ].includes(compact)
}

function isSerialNumber(value: string) {
  const compact = value.replace(/[^A-Za-z0-9]/g, "")
  if (compact.length < 6) return false
  if (!/\d/.test(compact)) return false
  return !/^(.)\1+$/.test(compact)
}

function isPublicIPv6(value: string) {
  if (!isIPv6(value)) return false
  const lower = value.toLowerCase()
  if (lower === "::1" || lower === "::") return false
  if (
    lower.startsWith("fe80:")
    || lower.startsWith("fc")
    || lower.startsWith("fd")
  )
    return false
  if (lower.startsWith("ff") || lower.startsWith("2001:db8:")) return false
  if (lower.startsWith("64:ff9b:") && !lower.startsWith("64:ff9b:1:"))
    return false
  return expectPublicIPv4Mapped(lower)
}

function expectPublicIPv4Mapped(value: string) {
  if (!value.startsWith("::ffff:")) return true
  const mapped = value.slice("::ffff:".length)
  if (!mapped.includes(".")) return false
  return (
    mapped !== "127.0.0.1"
    && !mapped.startsWith("10.")
    && !mapped.startsWith("192.168.")
  )
}

function isUsername(value: string) {
  const lower = value.toLowerCase()
  if (!/^[a-z_][a-z0-9._-]{2,31}$/.test(lower)) return false
  return ![
    "user",
    "users",
    "shared",
    "public",
    "default",
    "guest",
    "admin",
    "root",
    "ubuntu",
    "runner",
    "node",
    "app",
    "home",
    "test",
    "demo",
    "me",
    "you",
  ].includes(lower)
}

function isHostname(value: string) {
  const lower = value.toLowerCase()
  if (!/\.(?:internal|local|lan|corp|home|intra)$/.test(lower)) return false
  return !/^(?:localhost|example|test|invalid)(?:\.|$)/.test(lower)
}

function isBucket(value: string) {
  const lower = value.toLowerCase()
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(lower)) return false
  // Only explicit example names are exempt; ordinary name segments are valid.
  return !/^(?:example|sample|test|demo)(?:[-.]bucket)?$/.test(lower)
}

const PERSONAL_PATTERNS: Array<
  [PersonalLabel, RegExp, ((value: string) => boolean)?]
> = [
  [
    "EMAIL",
    /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/dg,
  ],
  // Mainland China mobile numbers, with or without +86.
  ["PHONE", /(?<![\d+])(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/dg],
  [
    "ID_CARD",
    /(?<![\dA-Za-z])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/dg,
    idCardChecksum,
  ],
  // Card networks start with 3-6; a checksum keeps timestamps and ids out.
  [
    "BANK_CARD",
    /(?<![\d-])[3-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{4,7}(?![\d-])/dg,
    luhn,
  ],
  [
    "IP",
    /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/dg,
    publicIpv4,
  ],
  [
    "IP",
    /(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/dg,
    isPublicIPv6,
  ],
  ["SSN", /\d{3}-\d{2}-\d{4}/dg, isSSN],
  [
    "PASSPORT",
    /(?:passport(?:\s*(?:no\.?|number|num|#))?|reisepass(?:nummer)?|护照(?:号码|号)?|護照(?:號碼|号碼|号码|番号)?|パスポート(?:番号)?)\s*(?:[:：=]\s*)?(?:是\s*|は\s*)?["']?([A-Z0-9]{6,9})/dgi,
    isPassport,
  ],
  [
    "IBAN",
    /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?)\b/dg,
    isIBAN,
  ],
  [
    "BIRTHDAY",
    /(?:date\s+of\s+birth|birth\s*[_-]?date|birthday|birth|dob|d\.o\.b\.?|born(?:\s+on)?|geburtsdatum|geboren(?:\s+am)?|生日|出生日期|出生年月日|出生于|出生於|誕生日|生年月日)\s*[:：=]?\s*(?:(?:is|was)\s+|是\s*|为\s*|為\s*|は\s*)?["']?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*,?\s+\d{4})/dgi,
    isBirthday,
  ],
  [
    "MAC",
    /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b|\b[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5}\b/dg,
    isMAC,
  ],
  [
    "SERIAL",
    /(?:serial\s*[_-]?(?:number|num|no\.?|#)?|s\/n|序列号|序列號|シリアル番号|seriennummer)\s*[:#=：]?\s*["']?([A-Za-z0-9][A-Za-z0-9-]{4,39})/dgi,
    isSerialNumber,
  ],
  [
    "USERNAME",
    /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)([a-z_][a-z0-9._-]{2,31})(?=[/\\])/dgi,
    isUsername,
  ],
  [
    "HOSTNAME",
    /\bhostname\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9.-]{2,253})/dgi,
    isHostname,
  ],
  [
    "HOSTNAME",
    /(?<![\w.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:internal|local|lan|corp|home|intra))(?![a-z0-9-])/dgi,
    isHostname,
  ],
  [
    "BUCKET",
    /\b(?:s3|gs|gcs):\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?=[/?#]|\b)/dgi,
    isBucket,
  ],
  [
    "BUCKET",
    /\b([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com\b/dgi,
    isBucket,
  ],
  [
    "BUCKET",
    /\bstorage\.googleapis\.com\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])(?=[/?#]|\b)/dgi,
    isBucket,
  ],
]

/** Cheap supersets that must pass before a personal regex runs. */
const PERSONAL_HINTS: Partial<Record<PersonalLabel, RegExp>> = {
  EMAIL: /@/,
  PHONE: /\d{11}/,
  ID_CARD: /\d{17}/,
  BANK_CARD: /\d{4}(?:[ -]?\d{4}){3}/,
  IP: /\.[0-9]|:[0-9A-Fa-f]{0,4}:/,
  SSN: /-/,
  PASSPORT: /passport|reisepass|护照|護照|パスポート/i,
  IBAN: /[A-Z]{2}\d{2}/,
  BIRTHDAY: /birth|dob|born|geburt|geboren|生日|出生|誕生日|生年月日/i,
  MAC: /[0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-]/,
  SERIAL: /serial|s\/n|序列号|序列號|シリアル|seriennummer/i,
  USERNAME: /\/home\/|\/Users\/|\\Users\\/i,
  HOSTNAME: /hostname\s*[:=]|\.(?:internal|local|lan|corp|home|intra)\b/i,
  BUCKET: /:\/\/|\.s3[.-]|storage\.googleapis\.com\//i,
}

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
      // One alternation instead of one regex per word: 100 custom words cost
      // four times the rest of the scan put together. Longest first keeps the
      // longer word winning when one starts inside another.
      words:
        config.words.length === 0 ?
          []
        : [
            new RegExp(
              [...config.words]
                .sort((a, b) => b.length - a.length)
                .map(escapeRegex)
                .join("|"),
              config.wordsAnyCase ? "gi" : "g",
            ),
          ],
      // Same idea as custom words: one alternation, longest first so a prefix
      // that contains another still masks the whole path.
      prefixes:
        config.homePrefixes.length === 0 ?
          []
        : [
            new RegExp(
              [...config.homePrefixes]
                .sort((a, b) => b.length - a.length)
                .map(escapeRegex)
                .join("|"),
              "g",
            ),
          ],
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

/** A field named just `key`, quoted or in a URL query, holding a long value. */
const KEY_FIELD_PATTERN =
  /(?:^|[^A-Za-z0-9_.-])["']?key["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/=]{16,})/gi
const KEY_FIELD_HINT = /["']?key["']?\s*[:=]/i

/** Password and key names written in CJK, with the value that follows. */
const CJK_NAMED_HINT =
  /密码|密碼|口令|安全码|安全碼|パスワード|暗証番号|비밀번호|암호|비번|密钥|密鑰|秘钥|秘鑰|私钥|私鑰|金钥|金鑰|令牌|权杖|權杖|授权码|授權碼|秘密鍵|トークン|シークレット|APIキー|アクセスキー|토큰|비밀키|API 키|API키/i
const CJK_PASSWORD_PATTERN =
  /(?:密码|密碼|口令|安全码|安全碼|パスワード|暗証番号|비밀번호|암호|비번)\s*(?:[:：=]\s*|[为為是]\s*[:：]?\s*|は\s*|는\s*)?["'“「]?([A-Za-z0-9_\-/+=~!@#%^&*]{4,63})/gi
const CJK_KEY_PATTERN =
  /(?:密钥|密鑰|秘钥|秘鑰|私钥|私鑰|金钥|金鑰|令牌|权杖|權杖|授权码|授權碼|秘密鍵|トークン|シークレット|APIキー|アクセスキー|토큰|비밀키|API 키|API키)\s*(?:[:：=]\s*|[为為是]\s*[:：]?\s*|は\s*|는\s*)?["'“「]?([A-Za-z0-9_\-/+=~!@#%^&*]{4,63})/gi
const CJK_ENGLISH_KEY_PATTERN =
  /(?:password|passwd|token|secret|api[ _-]?key|access[ _-]?key|private[ _-]?key|pwd|pin(?:[ _]?code)?)\s*(?:[为為是]\s*[:：]?|：)\s*["'“「]?([A-Za-z0-9_\-/+=~!@#%^&*]{4,63})/gi

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
    for (const [pattern, label, markers] of SECRET_PATTERNS) {
      // Large prompts made the bare alternations the single biggest cost
      // (~290ms of the ~330ms for 6MB); a required literal prefix is an exact
      // and much cheaper gate.
      if (markers && !markers.some((marker) => text.includes(marker))) continue
      for (const match of text.matchAll(pattern))
        add(match.index, match[0], "SECRET", label)
    }
    if (KEY_FIELD_HINT.test(text))
      for (const match of text.matchAll(KEY_FIELD_PATTERN)) {
        const value = match[1]
        const start = match.index + match[0].lastIndexOf(value)
        if (
          value.length >= 16
          && /[A-Za-z]/.test(value)
          && /\d/.test(value)
          && !isCodeReference(text, start, value)
        )
          add(start, value, "SECRET", "SECRET")
      }
    if (CJK_NAMED_HINT.test(text)) {
      const cjkPatterns: Array<[RegExp, RedactionLabel]> = [
        [CJK_PASSWORD_PATTERN, "PASSWORD"],
        [CJK_KEY_PATTERN, "SECRET"],
        [CJK_ENGLISH_KEY_PATTERN, "SECRET"],
      ]
      for (const [pattern, label] of cjkPatterns)
        for (const match of text.matchAll(pattern)) {
          const value = match[1]
          // "2048 位" and other counts are not secrets.
          if (value === undefined) continue
          if (/^\d+$/.test(value) && value.length < 6) continue
          add(match.index + match[0].lastIndexOf(value), value, "SECRET", label)
        }
    }
    const assignmentPatterns: Array<RegExp> = []
    if (SECRET_ASSIGNMENT_HINT.test(text))
      assignmentPatterns.push(SECRET_ASSIGNMENT)
    if (text.includes("://")) assignmentPatterns.push(URL_PASSWORD)
    for (const pattern of assignmentPatterns) {
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
      const hint = PERSONAL_HINTS[label]
      if (hint && !hint.test(text)) continue
      for (const match of text.matchAll(pattern)) {
        const value = match[1] ?? match[0]
        const start = match.indices?.[1]?.[0] ?? match.index
        if (!valid || valid(value)) add(start, value, "PERSONAL", label)
      }
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
