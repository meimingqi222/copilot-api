/**
 * Session ID Cache — stable per-credential session identifiers.
 *
 * The official Claude Code CLI sends a stable `X-Claude-Code-Session-Id`
 * on every request within a session. When copilot-api doesn't receive one
 * from the client, it needs to generate a stable ID per credential so the
 * Anthropic backend can reuse cached prompt prefixes.
 *
 * This cache generates a random UUID on first access for a given credential
 * key and persists it to disk so it survives process restarts. TTL is 1
 * hour with sliding expiration.
 *
 * Mirrors CPA's helps/session_id_cache.go.
 */

import { randomUUID } from "node:crypto"

import { PersistentTTLMap, hashKeyPart } from "./persistent-map"

const SESSION_ID_TTL_MS = 60 * 60_000 // 1 hour

const cache = new PersistentTTLMap<string>(
  "session-id-cache",
  SESSION_ID_TTL_MS,
)

let initPromise: Promise<void> | undefined

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = cache.init()
  }
  await initPromise
}

/**
 * Returns a stable session ID for the given credential key (typically the
 * account ID or API key). If no key is provided, returns a fresh random
 * UUID (no persistence).
 *
 * The session ID is persisted across restarts and refreshed on each access
 * (sliding TTL).
 */
export async function getStableSessionId(
  credentialKey: string,
): Promise<string> {
  if (!credentialKey.trim()) {
    return randomUUID()
  }
  await ensureInit()
  const key = hashKeyPart(credentialKey)
  const existing = cache.get(key)
  if (existing) return existing
  // setNX ensures only one UUID per key even under concurrent first-access.
  return cache.setNX(key, randomUUID())
}
