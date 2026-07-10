/**
 * Session → credential affinity cache.
 *
 * Mirrors CPA's SessionCache: binds a session id to a connection/credential
 * pair so multi-account routing keeps the same upstream cache namespace.
 */

import type { RouteTarget } from "~/lib/provider-connections"

import { state } from "~/lib/state"

import { CACHE_UTILIZATION_DEFAULTS } from "./provider-cache"

const DEFAULT_TTL_MS = CACHE_UTILIZATION_DEFAULTS.sessionAffinityTtlMs
/** How often to scan the map for expired entries. */
const PRUNE_INTERVAL_MS = 60_000
/** Hard cap; when exceeded, drop soonest-to-expire entries first. */
const MAX_AFFINITY_ENTRIES = 10_000

interface AffinityEntry {
  /** connectionId::credentialId */
  authKey: string
  expiresAt: number
}

const entries = new Map<string, AffinityEntry>()
let lastPruneAt = 0

export function affinityAuthKey(target: RouteTarget): string {
  return `${target.connectionId}::${target.credentialId}`
}

export function affinityCacheKey(
  sessionId: string,
  modelId: string,
  protocol?: string,
): string {
  const provider = protocol?.trim() || "any"
  return `${provider}::${sessionId}::${modelId}`
}

export function getSessionAffinity(
  cacheKey: string,
  options: { refresh?: boolean } = {},
): string | undefined {
  maybePruneAffinityEntries()
  const entry = entries.get(cacheKey)
  if (!entry) return undefined
  const now = Date.now()
  if (now >= entry.expiresAt) {
    entries.delete(cacheKey)
    return undefined
  }
  if (options.refresh !== false) {
    entry.expiresAt = now + getAffinityTtlMs()
    entries.set(cacheKey, entry)
  }
  return entry.authKey
}

export function setSessionAffinity(cacheKey: string, authKey: string): void {
  if (!cacheKey || !authKey) return
  maybePruneAffinityEntries()
  entries.set(cacheKey, {
    authKey,
    expiresAt: Date.now() + getAffinityTtlMs(),
  })
  enforceAffinityEntryCap()
}

/** Drop all bindings for a connection/credential (e.g. when it cools down). */
export function invalidateSessionAffinityAuth(authKey: string): void {
  if (!authKey) return
  for (const [key, entry] of entries) {
    if (entry.authKey === authKey) {
      entries.delete(key)
    }
  }
}

export function clearSessionAffinityForTest(): void {
  entries.clear()
  lastPruneAt = 0
}

/** Test hook: number of live affinity bindings. */
export function getSessionAffinitySizeForTest(): number {
  return entries.size
}

/** Test hook: force prune scan regardless of interval. */
export function pruneSessionAffinityForTest(now = Date.now()): number {
  return pruneExpiredAffinityEntries(now)
}

function maybePruneAffinityEntries(now = Date.now()): void {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  pruneExpiredAffinityEntries(now)
}

function pruneExpiredAffinityEntries(now: number): number {
  let removed = 0
  for (const [key, entry] of entries) {
    if (now >= entry.expiresAt) {
      entries.delete(key)
      removed += 1
    }
  }
  return removed
}

function enforceAffinityEntryCap(): void {
  if (entries.size <= MAX_AFFINITY_ENTRIES) return
  const overflow = entries.size - MAX_AFFINITY_ENTRIES
  const sorted = [...entries.entries()].sort(
    (a, b) => a[1].expiresAt - b[1].expiresAt,
  )
  for (let i = 0; i < overflow; i++) {
    const key = sorted[i]?.[0]
    if (key) entries.delete(key)
  }
}

export function isSessionAffinityEnabled(): boolean {
  return state.routing.sessionAffinity
}

export function isFillFirstEnabled(): boolean {
  const strategy = state.routing.strategy
  return (
    strategy === "fill-first" || strategy === "fillfirst" || strategy === "ff"
  )
}

/**
 * Codex-only identity confuse, matching CPA:
 * enabled only when codex.identityConfuse is true AND
 * (session-affinity OR fill-first strategy).
 */
export function isCodexIdentityConfuseEnabled(): boolean {
  if (!state.routing.identityConfuse) return false
  return isSessionAffinityEnabled() || isFillFirstEnabled()
}

function getAffinityTtlMs(): number {
  const ttl = state.routing.sessionAffinityTtlMs
  return typeof ttl === "number" && ttl > 0 ? ttl : DEFAULT_TTL_MS
}
