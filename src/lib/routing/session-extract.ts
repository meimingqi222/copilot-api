/**
 * Extract session identifiers for cache-affinity routing.
 *
 * Mirrors CPA's extractSessionIDs (sdk/cliproxy/auth/selector.go):
 *   1. metadata.user_id Claude Code session format
 *   2. X-Session-ID / session_id / Session_id headers (not x-client-request-id)
 *   3. prompt_cache_key (body or header)
 *   4. conversation_id
 *   5. Message-prefix hash (system + first user [+ first assistant])
 *
 * Note: x-client-request-id is intentionally excluded — it is a per-request
 * trace id on many clients and would break multi-turn affinity if used as a
 * session key.
 */

import { createHash } from "node:crypto"

const CLAUDE_SESSION_SUFFIX = /_session_([a-f0-9-]+)$/i

export interface ExtractedSessionIds {
  /** Primary affinity key (stable after first turn when hash-based). */
  primaryId: string
  /**
   * Fallback key used to inherit binding from turn-1 hash (without assistant)
   * when the primary full-hash is not yet bound.
   */
  fallbackId: string
}

export interface SessionExtractInput {
  headers?: Record<string, string | undefined> | null
  payload?: unknown
}

/**
 * Returns primary + fallback session IDs for affinity routing.
 * Empty strings mean "no session extracted".
 */
export function extractSessionIds(
  input: SessionExtractInput,
): ExtractedSessionIds {
  const headers = normalizeHeaders(input.headers)
  const payload =
    input.payload && typeof input.payload === "object" ?
      (input.payload as Record<string, unknown>)
    : undefined

  // 1. Claude Code metadata.user_id
  const fromUserId = extractClaudeSessionFromPayload(payload)
  if (fromUserId) {
    return { primaryId: fromUserId, fallbackId: "" }
  }

  // 2. Explicit session headers (stable conversation identifiers only).
  // Do NOT use x-client-request-id — many clients send a unique UUID per
  // request for tracing, which would shatter multi-turn affinity.
  const headerCandidates = [
    headers["x-session-id"],
    headers["session_id"],
    headers["session-id"],
    headers["x-claude-code-session-id"],
    headers["x-antigravity-session-id"],
    headers["x-windsurf-session-id"],
    headers["x-grok-conv-id"],
    headers.prompt_cache_key,
  ]
  for (const value of headerCandidates) {
    if (value) {
      return { primaryId: value, fallbackId: "" }
    }
  }

  if (!payload) {
    return { primaryId: "", fallbackId: "" }
  }

  // 3. Body-level prompt_cache_key / conversation_id
  const bodyCacheKey = readTrimmedString(payload.prompt_cache_key)
  if (bodyCacheKey) {
    return { primaryId: bodyCacheKey, fallbackId: "" }
  }
  const metadata = asRecord(payload.metadata)
  if (metadata) {
    const metaCacheKey = readTrimmedString(metadata.prompt_cache_key)
    if (metaCacheKey) {
      return { primaryId: metaCacheKey, fallbackId: "" }
    }
  }
  const conversationId = readTrimmedString(payload.conversation_id)
  if (conversationId) {
    return { primaryId: `conv:${conversationId}`, fallbackId: "" }
  }

  // 4. Message content hash fallback
  return extractMessageHashIds(payload)
}

/**
 * Claude Code encodes session id in metadata.user_id either as:
 *   - suffix `_session_<uuid>`
 *   - JSON `{"session_id":"..."}`
 */
export function extractClaudeSessionFromPayload(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  if (!payload) return undefined
  const metadata = asRecord(payload.metadata)
  const userId = metadata ? readTrimmedString(metadata.user_id) : undefined
  if (!userId) return undefined

  const suffix = userId.match(CLAUDE_SESSION_SUFFIX)
  if (suffix?.[1]) {
    return `claude:${suffix[1]}`
  }
  if (userId.startsWith("{")) {
    try {
      const parsed = JSON.parse(userId) as { session_id?: unknown }
      const sid = readTrimmedString(parsed.session_id)
      if (sid) return `claude:${sid}`
    } catch {
      // ignore
    }
  }
  // Non-Claude user_id still usable as affinity key
  return `user:${userId}`
}

/**
 * Hash system + first user (+ optional first assistant) for sticky routing
 * when the client sends no session id.
 */
export function extractMessageHashIds(
  payload: Record<string, unknown>,
): ExtractedSessionIds {
  let systemPrompt = readTopLevelSystemPrompt(payload)
  let firstUser = ""
  let firstAssistant = ""

  // OpenAI/Claude messages array
  const messages = payload.messages
  if (Array.isArray(messages)) {
    for (const raw of messages) {
      const msg = asRecord(raw)
      if (!msg) continue
      const role = readTrimmedString(msg.role)
      const content = extractMessageContent(msg.content)
      if (!role || !content) continue
      if (role === "system" && !systemPrompt) {
        systemPrompt = truncate(content, 100)
      } else if (role === "user" && !firstUser) {
        firstUser = truncate(content, 100)
      } else if (role === "assistant" && !firstAssistant) {
        firstAssistant = truncate(content, 100)
      }
      if (systemPrompt && firstUser && firstAssistant) break
    }
  }

  // Responses API: instructions + input
  if (!systemPrompt) {
    const instructions = readTrimmedString(payload.instructions)
    if (instructions) systemPrompt = truncate(instructions, 100)
  }
  if (!firstUser || !firstAssistant) {
    const fromInput = extractRolesFromResponsesInput(payload.input, {
      systemPrompt,
      firstUser,
      firstAssistant,
    })
    systemPrompt = fromInput.systemPrompt
    firstUser = fromInput.firstUser
    firstAssistant = fromInput.firstAssistant
  }

  // Antigravity / Gemini-shaped contents
  if (!firstUser) {
    const fromGemini = extractRolesFromGeminiContents(payload, firstAssistant)
    firstUser = fromGemini.firstUser
    firstAssistant = fromGemini.firstAssistant
  }

  if (!systemPrompt && !firstUser) {
    return { primaryId: "", fallbackId: "" }
  }

  const shortHash = computeSessionHash(systemPrompt, firstUser, "")
  if (!firstAssistant) {
    return { primaryId: shortHash, fallbackId: "" }
  }
  return {
    primaryId: computeSessionHash(systemPrompt, firstUser, firstAssistant),
    fallbackId: shortHash,
  }
}

function readTopLevelSystemPrompt(payload: Record<string, unknown>): string {
  const topSystem = payload.system
  if (typeof topSystem === "string") return truncate(topSystem, 100)
  if (!Array.isArray(topSystem)) return ""
  for (const part of topSystem) {
    const text = readTrimmedString(asRecord(part)?.text)
    if (text) return truncate(text, 100)
  }
  return ""
}

function extractRolesFromResponsesInput(
  input: unknown,
  seed: { systemPrompt: string; firstUser: string; firstAssistant: string },
): { systemPrompt: string; firstUser: string; firstAssistant: string } {
  let { systemPrompt, firstUser, firstAssistant } = seed
  if (typeof input === "string" && !firstUser) {
    return { systemPrompt, firstUser: truncate(input, 100), firstAssistant }
  }
  if (!Array.isArray(input)) {
    return { systemPrompt, firstUser, firstAssistant }
  }
  for (const raw of input) {
    const item = asRecord(raw)
    if (!item) continue
    const type = readTrimmedString(item.type)
    if (type === "reasoning") continue
    if (type && type !== "message") continue
    const role = readTrimmedString(item.role)
    if (!role) continue
    const content = extractMessageContent(item.content)
    if (!content) continue
    if ((role === "developer" || role === "system") && !systemPrompt) {
      systemPrompt = truncate(content, 100)
    } else if (role === "user" && !firstUser) {
      firstUser = truncate(content, 100)
    } else if (role === "assistant" && !firstAssistant) {
      firstAssistant = truncate(content, 100)
    }
    if (firstUser && firstAssistant) break
  }
  return { systemPrompt, firstUser, firstAssistant }
}

function extractRolesFromGeminiContents(
  payload: Record<string, unknown>,
  firstAssistantSeed: string,
): { firstUser: string; firstAssistant: string } {
  let firstUser = ""
  let firstAssistant = firstAssistantSeed
  const contents = payload.contents ?? asRecord(payload.request)?.contents
  if (!Array.isArray(contents)) return { firstUser, firstAssistant }
  for (const raw of contents) {
    const item = asRecord(raw)
    if (!item) continue
    const role = readTrimmedString(item.role)
    const text = extractGeminiPartsText(item.parts)
    if (!text) continue
    if ((role === "user" || role === "human") && !firstUser) {
      firstUser = truncate(text, 100)
    } else if ((role === "model" || role === "assistant") && !firstAssistant) {
      firstAssistant = truncate(text, 100)
    }
    if (firstUser && firstAssistant) break
  }
  return { firstUser, firstAssistant }
}

/**
 * Stable L1 upstream session id for multi-turn conversations.
 *
 * When the primary key is the full message hash (system+user+assistant) and
 * fallback is the short turn-1 hash (system+user), prefer the short hash so
 * Session_id / conv id does not change between turn 1 and turn 2+.
 * L0 affinity still uses primary + fallback inheritance for routing.
 */
export function resolveStableSessionId(ids: ExtractedSessionIds): string {
  return ids.fallbackId || ids.primaryId
}

/** FNV-1a 64-bit style hash string matching CPA's msg:xxxxxxxxxxxxxxxx form. */
export function computeSessionHash(
  systemPrompt: string,
  userMsg: string,
  assistantMsg: string,
): string {
  // Use sha256 truncated for portability (CPA uses FNV-1a; affinity only
  // needs stability within this process, not byte-identical hashes).
  const parts: Array<string> = []
  if (systemPrompt) parts.push(`sys:${systemPrompt}\n`)
  if (userMsg) parts.push(`usr:${userMsg}\n`)
  if (assistantMsg) parts.push(`ast:${assistantMsg}\n`)
  const digest = createHash("sha256").update(parts.join("")).digest("hex")
  return `msg:${digest.slice(0, 16)}`
}

/**
 * Stable Antigravity/Gemini sessionId from first user text.
 * Matches CPA generateStableSessionID format: "-<positive-int64>".
 */
export function generateAntigravityStableSessionId(
  firstUserText: string,
): string {
  const hash = createHash("sha256").update(firstUserText).digest()
  // Big-endian first 8 bytes, clear sign bit → positive int64 range as string
  const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength)
  // JS BigInt avoids overflow; keep as decimal string with leading '-'
  const hi = view.getUint32(0, false)
  const lo = view.getUint32(4, false)
  // Clear top bit of hi to match 0x7FFFFFFFFFFFFFFF mask
  const maskedHi = hi & 0x7fff_ffff
  const n = (BigInt(maskedHi) << 32n) | BigInt(lo)
  return `-${n.toString()}`
}

// ── helpers ──────────────────────────────────────────────────────────

function normalizeHeaders(
  headers?: Record<string, string | undefined> | null,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.trim()) {
      out[key.toLowerCase()] = value.trim()
    }
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  return undefined
}

function truncate(value: string, maxLen: number): string {
  return value.length > maxLen ? value.slice(0, maxLen) : value
}

function extractMessageContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const texts: Array<string> = []
  for (const part of content) {
    const record = asRecord(part)
    if (!record) continue
    const type = readTrimmedString(record.type)
    if (
      type === "text"
      || type === "input_text"
      || type === "output_text"
      || !type
    ) {
      const text = readTrimmedString(record.text)
      if (text) texts.push(text)
    }
  }
  return texts.join(" ")
}

function extractGeminiPartsText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const texts: Array<string> = []
  for (const part of parts) {
    const record = asRecord(part)
    const text = record ? readTrimmedString(record.text) : undefined
    if (text) texts.push(text)
  }
  return texts.join(" ")
}
