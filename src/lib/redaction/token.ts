/**
 * Placeholder syntax shared by masking, restoration, streaming and the
 * inspection view. A placeholder is `{{LABEL_suffix}}`: the label names what
 * the value is (so the model can reason about it), the suffix is a keyed hash.
 */

/** Category: what the settings switch on/off and what stats are grouped by. */
export type RedactionKind = "SECRET" | "HOME" | "WORD" | "PERSONAL"

const PERSONAL_LABELS = [
  "EMAIL",
  "PHONE",
  "ID_CARD",
  "BANK_CARD",
  "IP",
  "SSN",
  "PASSPORT",
  "IBAN",
  "BIRTHDAY",
  "MAC",
  "SERIAL",
  "USERNAME",
  "HOSTNAME",
  "BUCKET",
] as const
export type PersonalLabel = (typeof PERSONAL_LABELS)[number]

const REDACTION_LABELS = [
  "SECRET",
  "PASSWORD",
  "API_KEY",
  "PRIVATE_KEY",
  "TOKEN",
  "HOME",
  "WORD",
  ...PERSONAL_LABELS,
] as const
export type RedactionLabel = (typeof REDACTION_LABELS)[number]

const LABEL_SET = new Set<string>(REDACTION_LABELS)
// Longest first, so the alternation never stops at a label's prefix.
const LABEL_SOURCE = [...REDACTION_LABELS]
  .sort((a, b) => b.length - a.length)
  .join("|")

/**
 * Current suffixes are 8 base32 characters (16 on a hash collision). The
 * 32-hex form is what earlier versions sent; clients still replay it, so it
 * must stay recognized as an opaque placeholder.
 */
const SUFFIX_SOURCE = "(?:[a-z2-7]{16}|[a-z2-7]{8}|[a-f0-9]{32})"
const TOKEN_SOURCE = String.raw`\{\{(?:${LABEL_SOURCE})_${SUFFIX_SOURCE}\}\}`

/** Exact placeholders as this proxy writes them. */
export function tokenPattern(): RegExp {
  return new RegExp(TOKEN_SOURCE, "g")
}

/**
 * Placeholders as a model may echo them: spaces inside the braces or another
 * case. Group 1 is the label, group 2 the suffix.
 */
const LOOSE_SOURCE = String.raw`\{\{\s*([A-Za-z_]+?)_([A-Za-z0-9]{16}|[A-Za-z0-9]{8}|[A-Fa-f0-9]{32})\s*\}\}`

export function loosePattern(): RegExp {
  return new RegExp(LOOSE_SOURCE, "g")
}

/** The canonical placeholder a loose match stands for, if it can be one. */
export function canonicalToken(label: string, suffix: string): string | null {
  const upper = label.toUpperCase()
  if (!LABEL_SET.has(upper)) return null
  return `{{${upper}_${suffix.toLowerCase()}}}`
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"

export function base32(bytes: Uint8Array, length: number): string {
  let out = ""
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5 && out.length < length) {
      out += BASE32[(buffer >> (bits - 5)) & 31]
      bits -= 5
    }
    if (out.length >= length) break
  }
  return out
}

/**
 * The end of a streamed text that may be the start of a placeholder, so it
 * must be held until the next chunk shows whether it is one.
 */
export function pendingTokenSuffix(text: string): string {
  if (text.endsWith("{") && !text.endsWith("{{")) return "{"
  const start = text.lastIndexOf("{{")
  if (start < 0) return ""
  const suffix = text.slice(start)
  // Longest loose placeholder: braces, spaces, the longest label, "_", 32.
  if (suffix.length > 64) return ""
  return /^\{\{\s*[A-Za-z0-9_]*\s*\}?$/.test(suffix) ? suffix : ""
}
