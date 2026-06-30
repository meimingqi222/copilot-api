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
import { getStableSessionId } from "~/lib/cache/session-id-cache"

export interface CloudSessionIds {
  sessionId: string
  cascadeId: string
  promptId: string
}

/** Legacy sentinel — only used in tests; production always resolves a stable key. */
export const DEFAULT_CONVERSATION_KEY = "__default__"

export interface CloudSessionCacheOpts {
  host: string
  apiKey: string
  conversationKey?: string
  cascadeIdOverride?: string
}

export interface ResolveWindsurfConversationKeyOptions {
  forwardedHeaders?: Record<string, string | undefined>
  /** OpenAI body field — primary cache key for Codex-style clients. */
  promptCacheKey?: string | null
  /** OpenAI `user` field — stable per end-user when set by the client. */
  user?: string | null
  /** copilot-api authenticated user id (multi-user API key mode). */
  clientUserId?: string
  /** Windsurf upstream account id — last-resort stable scope. */
  accountId: string
}

const CLOUD_SESSION_TTL_MS = 60 * 60_000 // 1 hour, matches Claude session-id cache

interface StoredCloudSessionIds {
  sessionId: string
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
  return host.replace(/\/$/, "") || "https://server.codeium.com"
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
 *   3. OpenAI `user` field
 *   4. copilot-api authenticated client user id
 *   5. Stable persisted id per windsurf account (survives restarts)
 */
export async function resolveWindsurfConversationKey(
  opts: ResolveWindsurfConversationKeyOptions,
): Promise<string> {
  const fromHeader = readHeaderSession(opts.forwardedHeaders)
  if (fromHeader) return fromHeader

  const bodyCacheKey = opts.promptCacheKey?.trim()
  if (bodyCacheKey) return bodyCacheKey

  const user = opts.user?.trim()
  if (user) return `user:${user}`

  const clientUserId = opts.clientUserId?.trim()
  if (clientUserId) {
    return getStableSessionId(`windsurf:client:${clientUserId}`)
  }

  return getStableSessionId(`windsurf:account:${opts.accountId}`)
}

export async function getOrAllocateCloudSessionIds(
  opts: CloudSessionCacheOpts,
): Promise<CloudSessionIds> {
  await ensureCloudSessionInit()
  const conversationKey =
    opts.conversationKey?.trim() || DEFAULT_CONVERSATION_KEY
  const key = hashKeyPart(cacheKey(opts))
  let stored = persistedSessions.get(key)

  if (!stored) {
    stored = {
      sessionId: randomUUID(),
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
    sessionId: stored.sessionId,
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
