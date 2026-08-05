/**
 * Per-conversation cloud-direct session IDs (opencode-windsurf-auth pattern).
 *
 * Stable cascade_id (proto field #16) and metadata session_id (field #10)
 * across turns improve server-side prompt-cache hit rate.
 * Field #22 prompt_id is also stable per conversation — verified from live
 * Devin CLI capture where the same f22 UUID is reused across 7-8 primary
 * conversation turns (17/141 requests carry f22; 124 subagent calls omit it).
 *
 * Conversation keys are resolved automatically when clients omit session headers
 * (same idea as Claude's getStableSessionId / Codex prompt_cache_key).
 */

import { randomUUID } from "node:crypto"

import { hashKeyPart, PersistentTTLMap } from "~/lib/cache/persistent-map"

import { normalizeWindsurfBaseUrl } from "./base-url"

export interface CloudSessionIds {
  /** Stable cascade id sent on the wire. */
  cascadeId: string
  /** Stable prompt id sent on the wire when the upstream supports field 17. */
  promptId: string
}

/** Legacy sentinel — only used by callers that intentionally omit a key. */
export const DEFAULT_CONVERSATION_KEY = "__default__"

export interface CloudSessionCacheOpts {
  host: string
  apiKey: string
  conversationKey?: string
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

const CLOUD_SESSION_TTL_MS = 60 * 60_000 // 1 hour, matches Claude session-id cache

interface StoredCloudSessionIds {
  cascadeId: string
  promptId: string
  conversationKey: string
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

function normalizeHost(host: string): string {
  return normalizeWindsurfBaseUrl(host)
}

function cacheKey(opts: CloudSessionCacheOpts): string {
  const host = normalizeHost(opts.host)
  const conversationKey =
    opts.conversationKey?.trim() || DEFAULT_CONVERSATION_KEY
  return `${host}\x1f${opts.apiKey}\x1f${conversationKey}`
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
 *   1. Session headers (x-windsurf-session-id, session_id, prompt_cache_key header)
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

export async function getOrAllocateCloudSessionIds(
  opts: CloudSessionCacheOpts,
): Promise<CloudSessionIds> {
  const conversationKey =
    opts.conversationKey?.trim() || DEFAULT_CONVERSATION_KEY
  if (opts.persist === false) {
    return {
      cascadeId: opts.cascadeIdOverride ?? randomUUID(),
      promptId: randomUUID(),
    }
  }

  await ensureCloudSessionInit()
  const key = hashKeyPart(cacheKey(opts))
  let stored = persistedSessions.get(key)

  if (!stored) {
    stored = {
      cascadeId: opts.cascadeIdOverride ?? randomUUID(),
      promptId: randomUUID(),
      conversationKey,
    }
    stored = persistedSessions.setNX(key, stored)
  } else if (
    opts.cascadeIdOverride
    && stored.cascadeId !== opts.cascadeIdOverride
  ) {
    stored = {
      ...stored,
      cascadeId: opts.cascadeIdOverride,
    }
    persistedSessions.set(key, stored)
  } else {
    persistedSessions.set(key, stored)
  }

  return {
    cascadeId: stored.cascadeId,
    promptId: stored.promptId,
  }
}

export function clearCloudSessionCache(conversationKey?: string): void {
  if (!conversationKey) {
    for (const [key] of persistedSessions.entries()) {
      persistedSessions.delete(key)
    }
    return
  }
  const trimmed = conversationKey.trim()
  for (const [key, stored] of persistedSessions.entries()) {
    if (stored.conversationKey === trimmed) {
      persistedSessions.delete(key)
    }
  }
}

/** Test hook: drop all persisted windsurf cloud session entries. */
export function resetCloudSessionCacheForTest(): void {
  for (const [key] of persistedSessions.entries()) {
    persistedSessions.delete(key)
  }
}
