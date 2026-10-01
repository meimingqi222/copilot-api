/**
 * Session → credential affinity cache.
 *
 * Mirrors CPA's SessionCache: binds a session id to a connection/credential
 * pair so multi-account routing keeps the same upstream cache namespace.
 */

import type { RouteTarget } from "~/lib/provider-connections"
import type { AffinityMode } from "~/lib/state"

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
  /** Tokens read from the vendor's prompt cache on the last answer. */
  lastCacheRead?: number
  /** When that last answer landed (ms epoch). */
  lastAt?: number
  /** Turn the binding was made in (for the `turn` mode). */
  turnKey?: string
  /** The model-agnostic session this binding belongs to, when known. */
  sessionKey?: string
}

/** A cache read worth keeping a session pinned for. */
const CACHE_WORTH_TOKENS = 1024
/** A binding colder than this is dropped: the prompt cache likely lapsed. */
const CACHE_COLD_MS = 5 * 60_000

const entries = new Map<string, AffinityEntry>()
/**
 * sessionKey (`provider::sessionId`) → the model-scoped cacheKey it currently
 * points at. Lets a conversation that changed model inside a group (Opus →
 * Sonnet, say) still find the account that answered it.
 */
const sessionIndex = new Map<string, string>()
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

/** A model-agnostic session key, for the cross-model affinity fallback. */
export function affinitySessionKey(
  sessionId: string,
  protocol?: string,
): string {
  const provider = protocol?.trim() || "any"
  return `${provider}::${sessionId}`
}

export function getSessionAffinity(
  cacheKey: string,
  options: { refresh?: boolean; turnKey?: string; mode?: AffinityMode } = {},
): string | undefined {
  maybePruneAffinityEntries()
  const entry = entries.get(cacheKey)
  if (!entry) return undefined
  const now = Date.now()
  if (now >= entry.expiresAt) {
    entries.delete(cacheKey)
    return undefined
  }
  // `turn`: a binding made in another turn is released.
  const mode = options.mode ?? affinityMode()
  if (
    mode === "turn"
    && entry.turnKey !== undefined
    && options.turnKey !== entry.turnKey
  ) {
    entries.delete(cacheKey)
    return undefined
  }
  // `auto`: keep only while the vendor's cache is worth it and still warm.
  if (mode === "auto" && entry.lastAt !== undefined) {
    const worth = (entry.lastCacheRead ?? 0) >= CACHE_WORTH_TOKENS
    const warm = now - entry.lastAt <= CACHE_COLD_MS
    if (!worth || !warm) {
      entries.delete(cacheKey)
      return undefined
    }
  }
  if (options.refresh !== false) {
    entry.expiresAt = now + getAffinityTtlMs()
    entries.set(cacheKey, entry)
  }
  return entry.authKey
}

export function setSessionAffinity(
  cacheKey: string,
  authKey: string,
  meta: { turnKey?: string; sessionKey?: string } = {},
): void {
  if (!cacheKey || !authKey) return
  maybePruneAffinityEntries()
  const previous = entries.get(cacheKey)
  const sameAuth = previous?.authKey === authKey
  const sessionKey = meta.sessionKey ?? previous?.sessionKey
  entries.set(cacheKey, {
    authKey,
    expiresAt: Date.now() + getAffinityTtlMs(),
    lastCacheRead: sameAuth ? previous.lastCacheRead : undefined,
    lastAt: sameAuth ? previous.lastAt : undefined,
    turnKey: meta.turnKey ?? (sameAuth ? previous.turnKey : undefined),
    sessionKey,
  })
  if (sessionKey) sessionIndex.set(sessionKey, cacheKey)
  enforceAffinityEntryCap()
}

/**
 * The auth key a model-agnostic session is bound to, whatever model scoped
 * binding it currently points at — the fallback that keeps a conversation on
 * the same account when the group sends its next turn to another model.
 */
export function getSessionAffinityBySession(
  sessionKey: string,
  options: { turnKey?: string; mode?: AffinityMode } = {},
): string | undefined {
  const cacheKey = sessionIndex.get(sessionKey)
  if (!cacheKey) return undefined
  const bound = getSessionAffinity(cacheKey, {
    turnKey: options.turnKey,
    mode: options.mode,
  })
  if (!bound) sessionIndex.delete(sessionKey)
  return bound
}

/**
 * Record how much the vendor's prompt cache served for an auth key, so the
 * `auto` mode can decide whether sticking is still worth it next turn.
 */
export function noteSessionAffinityCacheRead(
  authKey: string,
  cacheReadTokens: number,
  now = Date.now(),
): void {
  if (!authKey) return
  for (const entry of entries.values()) {
    if (entry.authKey === authKey) {
      entry.lastCacheRead = cacheReadTokens
      entry.lastAt = now
    }
  }
}

/** The active affinity mode, honouring the legacy boolean switch. */
export function affinityMode(): AffinityMode {
  return state.routing.affinity
}

/** Drop all bindings for a connection/credential (e.g. when it cools down). */
export function invalidateSessionAffinityAuth(authKey: string): void {
  if (!authKey) return
  for (const [key, entry] of entries) {
    if (entry.authKey === authKey) {
      dropEntry(key)
    }
  }
}

export function clearSessionAffinityForTest(): void {
  entries.clear()
  sessionIndex.clear()
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
      dropEntry(key)
      removed += 1
    }
  }
  return removed
}

/** Delete a binding and any session index pointing at it. */
function dropEntry(cacheKey: string): void {
  const entry = entries.get(cacheKey)
  entries.delete(cacheKey)
  if (entry?.sessionKey && sessionIndex.get(entry.sessionKey) === cacheKey) {
    sessionIndex.delete(entry.sessionKey)
  }
}

function enforceAffinityEntryCap(): void {
  if (entries.size <= MAX_AFFINITY_ENTRIES) return
  const overflow = entries.size - MAX_AFFINITY_ENTRIES
  const sorted = [...entries.entries()].sort(
    (a, b) => a[1].expiresAt - b[1].expiresAt,
  )
  for (let i = 0; i < overflow; i++) {
    const key = sorted[i]?.[0]
    if (key) dropEntry(key)
  }
}

export function isSessionAffinityEnabled(): boolean {
  if (state.routing.affinity === "off") return false
  return state.routing.sessionAffinity
}

function isFillFirstEnabled(): boolean {
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
