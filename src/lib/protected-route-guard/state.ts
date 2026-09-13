import { getGuardConfig } from "~/lib/guard-config"
import { globalTimers } from "~/lib/timer-registry"

import type { PrincipalGuardState } from "./types"

export const BEHAVIOR_WINDOW_MS = 10 * 60 * 1000
export const REQUEST_WINDOW_MS = 60_000
export const UPSTREAM_429_DENSE_WINDOW_MS = 60_000
export const AUTH_PROBE_WINDOW_MS = 5 * 60 * 1000
export const CLEANUP_INTERVAL_MS = 5 * 60_000

export const guardState = new Map<string, PrincipalGuardState>()

export interface BucketState {
  tokens: number
  updatedAt: number
}

export const buckets = new Map<string, BucketState>()

export interface ShadowStat {
  reason: string
  hits: number
  lastSeen: number
}

export const shadowStats = new Map<string, ShadowStat>()

export function idleTtlMs(): number {
  return getGuardConfig().tempBlockMs + BEHAVIOR_WINDOW_MS
}

export function getOrCreateState(principal: string): PrincipalGuardState {
  let state = guardState.get(principal)
  if (state) {
    return state
  }

  state = {
    events: [],
    recentRequests: [],
    warned: false,
    lastSeen: 0,
    repeatCount: 0,
  }
  guardState.set(principal, state)
  return state
}

let cleanupTimer: ReturnType<typeof setInterval> | undefined

export function ensureCleanup(): void {
  if (cleanupTimer) {
    return
  }

  cleanupTimer = globalTimers.interval(() => {
    cleanupIdleState(Date.now())
  }, CLEANUP_INTERVAL_MS)
}

export function pruneState(state: PrincipalGuardState, now: number): void {
  const eventCutoff = now - BEHAVIOR_WINDOW_MS
  state.events = state.events.filter((e) => e.at >= eventCutoff)

  const requestCutoff = now - REQUEST_WINDOW_MS
  state.recentRequests = state.recentRequests.filter(
    (timestamp) => timestamp >= requestCutoff,
  )

  if (state.recentRequests.length === 0) {
    state.warned = false
  }

  if ((state.blockedUntil ?? 0) <= now) {
    state.blockedUntil = undefined
    state.blockReason = undefined
    state.blockedAt = undefined
  }
}

export function cleanupIdleState(now: number): void {
  const ttl = idleTtlMs()
  for (const [principal, state] of guardState) {
    pruneState(state, now)
    const hasActivePenalty = (state.blockedUntil ?? 0) > now
    const hasRecentActivity =
      state.events.length > 0 || state.recentRequests.length > 0

    if (hasActivePenalty || hasRecentActivity) {
      continue
    }

    if (now - state.lastSeen >= ttl) {
      guardState.delete(principal)
    }
  }
}

export function resetProtectedRouteGuardForTest(): void {
  guardState.clear()
  buckets.clear()
  shadowStats.clear()
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = undefined
  }
}

export function cleanupProtectedRouteGuardForTest(now = Date.now()): void {
  cleanupIdleState(now)
}

export function getProtectedRouteGuardSizeForTest(): number {
  return guardState.size
}

export function getPrincipalStateForTest(
  principal: string,
): PrincipalGuardState | undefined {
  return guardState.get(principal)
}
