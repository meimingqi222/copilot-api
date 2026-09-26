/**
 * Per-conversation cloud-direct session IDs (opencode-windsurf-auth pattern).
 *
 * Stable cascade_id (field #16) and thread-session session_id (field #15.1)
 * across turns improve server-side prompt-cache hit rate — same binding CPA
 * uses in BuildDevinGetChatMessageRequest. Field #22 must stay omitted: a
 * per-request random UUID there was observed to defeat KV-cache affinity.
 *
 * The cascade id must also be **derived, never allocated**: the upstream scopes
 * its KV cache for the `swe-*` models to the cascade, so two workers (or a
 * restart, or an expired cache file) that invent different cascade ids for the
 * same conversation split that cache and cut the hit rate to roughly 1/worker.
 * Everything here is a pure function of the conversation identity, exactly like
 * CPA's `resolveDevinSessionAndCascadeIDs` / `normalizeDevinUUID`.
 *
 * Conversation keys are resolved automatically when clients omit session headers
 * (same idea as Claude's getStableSessionId / Codex prompt_cache_key).
 */

import { createHash, randomUUID } from "node:crypto"

import { hashKeyPart, PersistentTTLMap } from "~/lib/cache/persistent-map"

export interface CloudSessionIds {
  /** Stable cascade id sent on the wire. */
  cascadeId: string
  /** Stable prompt id sent on the wire when the upstream supports field 17. */
  promptId: string
}

/** Legacy sentinel — only used by callers that intentionally omit a key. */
export const DEFAULT_CONVERSATION_KEY = "__default__"

export interface CloudSessionCacheOpts {
  conversationKey?: string
  /**
   * Stable upstream account identity (connection id). Part of the derivation so
   * two accounts serving the same client session never share one cascade — and
   * part of *that*, not of the credential token, so a token refresh cannot move
   * the conversation onto a cold cascade.
   */
  accountId?: string
  cascadeIdOverride?: string
  /** Skip persistence for request-scoped keys with no client conversation id. */
  persist?: boolean
}

export interface ResolvedWindsurfConversationKey {
  key: string
  persistent: boolean
}

export interface ResolveWindsurfConversationKeyOptions {
  forwardedHeaders?: Record<string, string | undefined>
  /** OpenAI body field — primary cache key for Codex-style clients. */
  promptCacheKey?: string | null
  /** OpenAI `user` field — accepted for API compatibility, not used as a key. */
  user?: string | null
  /** copilot-api authenticated user id (multi-user API key mode). */
  clientUserId?: string
  /** Windsurf upstream account id, retained for API compatibility. */
  accountId?: string
}

const CLOUD_SESSION_TTL_MS = readCloudSessionTtlMs()

/**
 * Lifetime of the conversation→rotation-salt entry. Since the ids are derived,
 * expiry no longer moves a conversation off its cascade — it only forgets an
 * explicit rotation, and `WINDSURF_SESSION_TTL_MS` bounds how long that lasts.
 */
function readCloudSessionTtlMs(): number {
  const fallback = 60 * 60_000 // 1 hour, matches Claude session-id cache
  const raw = process.env.WINDSURF_SESSION_TTL_MS?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(24 * 60 * 60_000, Math.max(5 * 60_000, parsed))
}

/**
 * Cache-file entry for a conversation. It no longer holds the ids themselves —
 * those are derived — only the rotation salt `clearCloudSessionCache` bumps.
 */
interface StoredCloudSessionIds {
  conversationKey: string
  /**
   * Rotation counter. Bumped only by `clearCloudSessionCache`, which is the one
   * deliberate way to move a conversation onto a fresh upstream cascade.
   */
  salt: number
}

/** RFC 4122 UUID v5 over the OID namespace, as CPA's `uuid.NewSHA1(uuid.NameSpaceOID, …)`. */
const UUID_V5_NAMESPACE_OID = Buffer.from(
  "6ba7b8119dad11d180b400c04fd430c8",
  "hex",
)

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidV5(name: string): string {
  const bytes = createHash("sha1")
    .update(UUID_V5_NAMESPACE_OID)
    .update(name, "utf8")
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Deterministic UUID for any session/conversation string (CPA `normalizeDevinUUID`).
 * An existing UUID is passed through so a client that already sends one keeps
 * its identity verbatim.
 */
export function devinSessionUuid(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return randomUUID()
  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase()
  return uuidV5(trimmed)
}

const persistedSessions = new PersistentTTLMap<StoredCloudSessionIds>(
  "windsurf-cloud-session",
  CLOUD_SESSION_TTL_MS,
)

let initPromise: Promise<void> | undefined

async function ensureCloudSessionInit(): Promise<void> {
  if (!initPromise) {
    initPromise = persistedSessions.init()
  }
  await initPromise
}

function cacheKey(opts: CloudSessionCacheOpts): string {
  // Deliberately excludes the host and the credential token: the salt lookup
  // has to follow the same identity as the derivation, or a token refresh would
  // read a fresh entry (salt 0) and silently rotate the conversation.
  const accountId = opts.accountId?.trim() || ""
  const conversationKey =
    opts.conversationKey?.trim() || DEFAULT_CONVERSATION_KEY
  return `${accountId}\x1f${conversationKey}`
}

function cloudSessionSeed(
  opts: CloudSessionCacheOpts,
  conversationKey: string,
  salt: number,
): string {
  const accountId = opts.accountId?.trim() || ""
  return salt > 0 ?
      `${accountId}\x1f${conversationKey}\x1frotate-${salt}`
    : `${accountId}\x1f${conversationKey}`
}

function readHeaderSession(
  forwarded?: Record<string, string | undefined>,
): string | undefined {
  if (!forwarded) return undefined
  const candidates = [
    forwarded["x-windsurf-session-id"],
    forwarded["x-claude-code-session-id"],
    forwarded.session_id,
    forwarded["session-id"],
    // Generic client conversation id (ZCode sends `x-session-id` on every
    // model request). Without this, chat clients without windsurf-specific
    // headers fall through to a fresh random key per request and lose
    // server-side prompt-cache affinity.
    forwarded["x-session-id"],
    forwarded.prompt_cache_key,
  ]
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * Resolve the conversation bucket for cascade/session reuse.
 *
 * Priority (mirrors Codex/Claude cache routing in copilot-api):
 *   1. Session headers (x-windsurf-session-id, session_id, x-session-id,
 *      prompt_cache_key header)
 *   2. `prompt_cache_key` in request body
 *   3. A fresh request-scoped id when no explicit conversation key exists
 */
export function resolveWindsurfConversationKey(
  opts: ResolveWindsurfConversationKeyOptions,
): ResolvedWindsurfConversationKey {
  const fromHeader = readHeaderSession(opts.forwardedHeaders)
  if (fromHeader) return { key: fromHeader, persistent: true }

  const bodyCacheKey = opts.promptCacheKey?.trim()
  if (bodyCacheKey) return { key: bodyCacheKey, persistent: true }

  // Match Devin/Cascade semantics: without an explicit conversation identity,
  // each request gets a fresh request-scoped bucket rather than sharing history
  // by user or account across unrelated conversations. It must not be persisted:
  // ordinary OpenAI clients do not send a session id, so persisting this UUID
  // would create one never-reused cache entry per request.
  return { key: randomUUID(), persistent: false }
}

/**
 * Resolve the cascade/prompt ids for a conversation.
 *
 * "Allocate" is now historical: the ids are *derived* from the conversation
 * identity (plus a rotation salt only `clearCloudSessionCache` ever bumps), so
 * every worker and every cold start arrives at the same cascade without shared
 * state. Only the rotation seed is persisted.
 */
export async function getOrAllocateCloudSessionIds(
  opts: CloudSessionCacheOpts,
): Promise<CloudSessionIds> {
  const conversationKey =
    opts.conversationKey?.trim() || DEFAULT_CONVERSATION_KEY

  // Request-scoped keys are already unique per request, so nothing has to be
  // remembered: the derivation itself yields a fresh, non-reused cascade.
  if (opts.persist === false) {
    const seed = cloudSessionSeed(opts, conversationKey, 0)
    return {
      cascadeId: opts.cascadeIdOverride ?? devinSessionUuid(seed),
      promptId: devinSessionUuid(`${seed}\x1fprompt`),
    }
  }

  await ensureCloudSessionInit()
  const key = hashKeyPart(cacheKey(opts))
  const existing = persistedSessions.get(key)
  const salt = existing?.salt ?? 0
  if (!existing) {
    persistedSessions.setNX(key, { conversationKey, salt: 0 })
  }

  const seed = cloudSessionSeed(opts, conversationKey, salt)
  return {
    cascadeId: opts.cascadeIdOverride ?? devinSessionUuid(seed),
    promptId: devinSessionUuid(`${seed}\x1fprompt`),
  }
}

export function clearCloudSessionCache(conversationKey?: string): void {
  if (!conversationKey) {
    for (const [key, stored] of persistedSessions.entries()) {
      persistedSessions.set(key, { ...stored, salt: stored.salt + 1 })
    }
    return
  }
  const trimmed = conversationKey.trim()
  for (const [key, stored] of persistedSessions.entries()) {
    if (stored.conversationKey === trimmed) {
      persistedSessions.set(key, { ...stored, salt: stored.salt + 1 })
    }
  }
}

/** Test hook: drop all persisted windsurf cloud session entries. */
export function resetCloudSessionCacheForTest(): void {
  for (const [key] of persistedSessions.entries()) {
    persistedSessions.delete(key)
  }
}
