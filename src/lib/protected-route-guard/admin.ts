import { getGuardConfig } from "~/lib/guard-config"

import type { TempBlockInfo } from "./types"

import { getOrCreateState, guardState, shadowStats } from "./state"

export function parsePrincipal(principal: string): TempBlockInfo["kind"] {
  if (principal.startsWith("user:")) return "user"
  if (principal.startsWith("key:")) return "key"
  return "ip"
}

export function listTempBlocks(now = Date.now()): Array<TempBlockInfo> {
  const out: Array<TempBlockInfo> = []
  for (const [principal, state] of guardState) {
    const blockedUntil = state.blockedUntil ?? 0
    if (blockedUntil <= now) continue
    const kind = parsePrincipal(principal)
    out.push({
      principal,
      kind,
      userId: kind === "user" ? principal.slice(5) : undefined,
      clientIp: state.lastClientIp,
      userAgent: state.lastUserAgent,
      path: state.lastPath,
      model: state.lastModel,
      routeKind: state.lastRouteKind,
      reason: state.blockReason ?? "active_block",
      behavior: state.lastBehavior,
      blockedUntil,
      blockedAt: state.blockedAt,
      retryAfterSeconds: Math.max(0, Math.ceil((blockedUntil - now) / 1000)),
      recentRequestCount: state.recentRequests.length,
      lastSeen: state.lastSeen,
      level: state.blockLevel,
      repeatCount: state.repeatCount,
      score: state.lastBehavior?.score,
      status: state.blockStatus ?? 403,
    })
  }
  return out.sort((a, b) => b.blockedUntil - a.blockedUntil)
}

export function unblockPrincipal(principal: string): boolean {
  const state = guardState.get(principal)
  if (!state) return false
  const hadBlock = (state.blockedUntil ?? 0) > Date.now()
  // Only arm suppression for a real active block — unblocking an idle
  // principal must not mute future legitimate enforcement.
  if (!hadBlock) {
    state.blockedUntil = undefined
    state.blockReason = undefined
    state.blockedAt = undefined
    state.blockStatus = undefined
    return true
  }
  const category = state.blockReason?.split(":")[0] ?? "behavior_block"
  state.blockedUntil = undefined
  state.blockReason = undefined
  state.blockedAt = undefined
  state.blockStatus = undefined
  // Suppress re-blocking for the same category while the admin investigates.
  state.suppressUntil = Date.now() + getGuardConfig().repeatSuppressMs
  state.suppressKey = category
  return true
}

export function blockPrincipal(
  principal: string,
  opts: { durationMs?: number; reason?: string } = {},
): TempBlockInfo {
  const now = Date.now()
  const duration = opts.durationMs ?? getGuardConfig().tempBlockMs
  const state = getOrCreateState(principal)
  state.blockedUntil = now + duration
  state.blockedAt = now
  state.blockReason = opts.reason ?? "manual_block"
  state.lastSeen = now
  state.blockLevel = "manual"
  state.blockStatus = 403
  const kind = parsePrincipal(principal)
  return {
    principal,
    kind,
    userId: kind === "user" ? principal.slice(5) : undefined,
    clientIp: state.lastClientIp,
    userAgent: state.lastUserAgent,
    path: state.lastPath,
    model: state.lastModel,
    routeKind: state.lastRouteKind,
    reason: state.blockReason,
    behavior: state.lastBehavior,
    blockedUntil: state.blockedUntil,
    blockedAt: now,
    retryAfterSeconds: Math.ceil(duration / 1000),
    recentRequestCount: state.recentRequests.length,
    lastSeen: now,
    level: state.blockLevel,
    repeatCount: state.repeatCount,
    score: state.lastBehavior?.score,
    status: state.blockStatus ?? 403,
  }
}

export function recordShadowHit(reason: string): void {
  const key = reason.split(":")[0] || reason
  const prev = shadowStats.get(key)
  shadowStats.set(key, {
    reason: key,
    hits: (prev?.hits ?? 0) + 1,
    lastSeen: Date.now(),
  })
}

export function listShadowStats(): Array<{
  reason: string
  hits: number
  lastSeen: number
}> {
  return [...shadowStats.values()].sort((a, b) => b.hits - a.hits)
}
