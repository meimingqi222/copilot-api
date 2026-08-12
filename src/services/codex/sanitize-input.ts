import { createHash } from "node:crypto"

import { logger } from "~/lib/logger"

const CODEX_INPUT_ITEM_ID_LIMIT = 64
/**
 * Signatures are base64url, i.e. pure ASCII, so string length is the byte
 * length — the check below can stay on `.length` and avoid materializing a
 * Buffer for a value that can legitimately be megabytes long.
 */
const MAX_REASONING_SIGNATURE_LENGTH = 32 * 1024 * 1024
const GPT_REASONING_SIGNATURE_REGEX = /^[\w-]+={0,2}$/

const ITEM_ID_PREFIXES: Record<string, string> = {
  message: "msg",
  reasoning: "rs",
  function_call: "fc",
  custom_tool_call: "ctc",
  custom_tool_call_output: "ctco",
}

/**
 * Apply the Codex input-item constraints at the final outbound boundary.
 * This mirrors CPA's encrypted reasoning cleanup and item-id normalization.
 */
export function sanitizeCodexInput(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body

  const storeEnabled = body.store === true
  // Mutable state object so the linter's control-flow analysis keeps
  // `dropped` a plain number (it is only incremented inside the map callback).
  const stats = { dropped: 0 }
  const signatureSanitized = body.input.map((entry) =>
    sanitizeReasoningEntry(entry, storeEnabled, stats),
  )
  if (stats.dropped > 0) {
    // The `gAAAA` prefix + fernet-shape check below is the only gate on
    // reasoning replay. If OpenAI ever changes the token format this drops
    // *every* signature silently and cross-turn thinking degrades with no
    // other symptom, so leave a trace that points straight at the cause.
    logger.debug(
      `codex sanitize: dropped ${stats.dropped} unrecognized reasoning `
        + `signature(s) from input (encrypted_content failed validation)`,
    )
  }
  const idSanitized = sanitizeInputItemIds(signatureSanitized)
  return { ...body, input: idSanitized }
}

function sanitizeReasoningEntry(
  entry: unknown,
  storeEnabled: boolean,
  stats: { dropped: number },
): unknown {
  const item = getRecord(entry)
  if (!item || item.type !== "reasoning") return entry

  const next = { ...item }
  const encryptedContent = next.encrypted_content
  const hasValidEncryptedContent =
    typeof encryptedContent === "string"
    && isValidGPTReasoningSignature(encryptedContent)

  if (encryptedContent !== undefined && !hasValidEncryptedContent) {
    delete next.encrypted_content
    stats.dropped += 1
  }
  if (!storeEnabled && !hasValidEncryptedContent) {
    delete next.id
  }
  return next
}

function sanitizeInputItemIds(input: Array<unknown>): Array<unknown> {
  const occupied = new Set<string>()
  const shortened = new Map<string, string>()

  for (const entry of input) {
    const item = getRecord(entry)
    if (!item || shouldDropEncryptedReasoning(item)) continue
    const normalized = normalizeItemId(item)
    if (
      normalized
      && codePointLength(normalized) <= CODEX_INPUT_ITEM_ID_LIMIT
    ) {
      occupied.add(normalized)
    }
  }

  const result: Array<unknown> = []
  for (const entry of input) {
    const item = getRecord(entry)
    if (!item) {
      result.push(entry)
      continue
    }
    if (shouldDropEncryptedReasoning(item)) continue

    const originalId = typeof item.id === "string" ? item.id : undefined
    let normalizedId = normalizeItemId(item)
    if (
      normalizedId
      && codePointLength(normalizedId) > CODEX_INPUT_ITEM_ID_LIMIT
    ) {
      const normalizedOriginalId = normalizedId
      const existing = shortened.get(normalizedId)
      if (existing) {
        normalizedId = existing
      } else {
        normalizedId = uniqueShortId(normalizedId, occupied)
        shortened.set(normalizedOriginalId, normalizedId)
        occupied.add(normalizedId)
      }
    }

    result.push(
      originalId !== undefined && normalizedId !== originalId ?
        { ...item, id: normalizedId }
      : entry,
    )
  }
  return result
}

function shouldDropEncryptedReasoning(item: Record<string, unknown>): boolean {
  return (
    item.type === "reasoning"
    && typeof item.id === "string"
    && codePointLength(item.id) > CODEX_INPUT_ITEM_ID_LIMIT
    && typeof item.encrypted_content === "string"
    && item.encrypted_content.length > 0
  )
}

function normalizeItemId(item: Record<string, unknown>): string | undefined {
  if (typeof item.id !== "string") return undefined
  const prefix =
    typeof item.type === "string" ? ITEM_ID_PREFIXES[item.type] : undefined
  if (!prefix || !item.id || item.id.startsWith(prefix)) return item.id
  return `${prefix}_${item.id}`
}

function uniqueShortId(id: string, occupied: Set<string>): string {
  for (let attempt = 0; ; attempt += 1) {
    const hashInput = attempt === 0 ? id : `${id}\0${attempt}`
    const suffix = `_${createHash("sha256").update(hashInput).digest("hex").slice(0, 16)}`
    const prefixLength = CODEX_INPUT_ITEM_ID_LIMIT - suffix.length
    const candidate = `${Array.from(id).slice(0, prefixLength).join("")}${suffix}`
    if (!occupied.has(candidate)) return candidate
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

export function isValidGPTReasoningSignature(value: string): boolean {
  if (!value || value !== value.trim()) return false
  if (value.length > MAX_REASONING_SIGNATURE_LENGTH) return false
  if (
    !value.startsWith("gAAAA")
    || !GPT_REASONING_SIGNATURE_REGEX.test(value)
  ) {
    return false
  }

  try {
    const decoded = Buffer.from(value, "base64url")
    if (decoded.toString("base64url") !== value.replace(/=+$/, "")) return false
    if (decoded.length < 73 || decoded[0] !== 0x80) return false
    const ciphertextLength = decoded.length - 1 - 8 - 16 - 32
    return ciphertextLength > 0 && ciphertextLength % 16 === 0
  } catch {
    return false
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}
