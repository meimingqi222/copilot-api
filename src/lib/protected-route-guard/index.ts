import type { Context } from "hono"

import { createHash } from "node:crypto"

import { HTTPError } from "~/lib/error"
import { getProtectedRouteKind } from "~/lib/protected-routes"
import { getClientIp } from "~/lib/utils"

import type { GuardInput, PrincipalBehavior } from "./types"

import { enforceTokenBucket } from "./bucket"
import {
  emitSuspiciousWarning,
  enforceActiveBlock,
  enforceBehaviorBlock,
  enforceProbeDetection,
} from "./enforcement"
import { isTrustedClient } from "./patterns"
import { analyzeBehavior } from "./scoring"
import {
  ensureCleanup,
  getOrCreateState,
  guardState,
  pruneState,
} from "./state"

export { blockPrincipal, listShadowStats, listTempBlocks } from "./admin"
export { unblockPrincipal } from "./admin"
export { ProtectedRouteGuardError } from "./enforcement"
export {
  cleanupProtectedRouteGuardForTest,
  getPrincipalStateForTest,
  getProtectedRouteGuardSizeForTest,
  idleTtlMs,
  maxBlockMs,
  resetProtectedRouteGuardForTest,
} from "./state"
export type { GuardInput, PrincipalBehavior } from "./types"
export type {
  PrincipalGuardState,
  ScoreBreakdown,
  TempBlockInfo,
} from "./types"

export function checkProtectedRouteGuard(
  c: Context,
  input: GuardInput = {},
): void {
  ensureCleanup()
  const routeKind = input.routeKind ?? getProtectedRouteKind(c.req.path)
  if (!routeKind) {
    return
  }

  // Skip guard for localhost / direct (no proxy) requests
  const clientIp = getClientIpFromRequest(c)
  if (
    process.env.NODE_ENV !== "test"
    && (clientIp === "127.0.0.1" || clientIp === "::1")
  ) {
    return
  }

  const principal = getPrincipalKey(c)
  const now = Date.now()
  const state = getOrCreateState(principal)
  const userAgent = c.req.header("user-agent")
  const trustedClient = input.trustedClient ?? isTrustedClient(userAgent)

  pruneState(state, now)
  state.lastSeen = now
  state.lastClientIp = clientIp
  if (userAgent !== undefined) state.lastUserAgent = userAgent
  state.lastPath = c.req.path
  if (input.model !== undefined) state.lastModel = input.model
  if (routeKind !== undefined) state.lastRouteKind = routeKind

  c.set("protectedRouteGuardPrincipal", principal)

  enforceTokenBucket({
    c,
    principal,
    state,
    routeKind,
    guardInput: { ...input, trustedClient },
    now,
  })

  enforceActiveBlock({
    c,
    principal,
    state,
    routeKind,
    guardInput: { ...input, trustedClient },
    now,
  })

  state.recentRequests.push(now)

  const contentHash =
    input.messageContent ?
      createHash("sha256")
        .update(input.messageContent)
        .digest("hex")
        .slice(0, 16)
    : undefined

  state.events.push({
    at: now,
    type: "request",
    path: c.req.path,
    model: input.model,
    contentHash,
  })

  const behavior = analyzeBehavior(state, now, {
    userAgent: c.req.header("user-agent"),
    trustedClient,
    currentContentHash: contentHash,
    currentModel: input.model,
    provider: input.provider,
  })
  c.set("protectedRouteGuardBehavior", behavior)

  enforceBehaviorBlock({
    c,
    principal,
    state,
    routeKind,
    guardInput: { ...input, trustedClient },
    now,
    behavior,
  })

  enforceProbeDetection({
    c,
    principal,
    state,
    routeKind,
    guardInput: { ...input, trustedClient },
    now,
  })

  emitSuspiciousWarning(c, { principal, state, behavior })
}

export function reportUpstream429(
  c: Context,
  provider?: string,
  responseBody?: string,
): void {
  const principal = c.get("protectedRouteGuardPrincipal")
  if (!principal) return

  // Only count 429s as suspicious for Copilot (GitHub's API).
  // Other providers have their own rate limits which are normal.
  if (provider && provider !== "copilot") return

  // Skip if responseBody indicates quota-related issue
  if (responseBody) {
    const bodyLower = responseBody.toLowerCase()
    if (
      bodyLower.includes("quota")
      || bodyLower.includes("rate_limit")
      || bodyLower.includes("rate limit")
      || bodyLower.includes("exhausted")
      || bodyLower.includes("billing")
    ) {
      return
    }
  }

  const state = guardState.get(principal)
  if (!state) return

  state.events.push({
    at: Date.now(),
    type: "upstream_429",
  })
}

export function reportRequestError(c: Context, error?: unknown): void {
  const principal = c.get("protectedRouteGuardPrincipal")
  if (!principal) return

  // Skip upstream 5xx errors or server-side issues
  if (error instanceof HTTPError && error.response.status >= 500) {
    return
  }

  // In production the log middleware reports with an explicit numeric status
  // and only 401/403 count (400 validation errors and 404s are user confusion,
  // not attacks; 429s are covered by the upstream429/copilot signal).
  // A missing/unknown error (tests, legacy callers) still counts.
  let status: number | undefined
  if (typeof error === "number" && Number.isFinite(error)) {
    status = Math.floor(error)
    if (status !== 401 && status !== 403) return
  } else if (error instanceof HTTPError) {
    const s = error.response.status
    if (s !== 401 && s !== 403) return
    status = s
  }

  const state = guardState.get(principal)
  if (!state) return

  state.events.push({
    at: Date.now(),
    type: "error",
    status,
  })
}

export function reportRequestSuccess(c: Context): void {
  const principal = c.get("protectedRouteGuardPrincipal")
  if (!principal) return

  const state = guardState.get(principal)
  if (!state) return

  state.events.push({
    at: Date.now(),
    type: "success",
  })
}

function getPrincipalKey(c: Context): string {
  const userId = c.get("userId")
  if (userId) {
    return `user:${userId}`
  }

  const bearerToken = extractBearerToken(c.req.header("authorization"))
  if (bearerToken) {
    const fingerprint = createHash("sha256")
      .update(bearerToken)
      .digest("hex")
      .slice(0, 16)
    return `key:${fingerprint}`
  }

  return `ip:${getClientIpFromRequest(c)}`
}

function extractBearerToken(
  authHeader: string | undefined,
): string | undefined {
  if (!authHeader) {
    return undefined
  }

  const trimmed = authHeader.trim()
  const match = trimmed.match(/^Bearer\s+(\S+)$/i)
  if (!match) {
    return undefined
  }

  return match[1]
}

function getClientIpFromRequest(c: Context): string {
  return getClientIp(c)
}

export function getPrincipalBehaviorForTest(
  c: Context,
): PrincipalBehavior | undefined {
  const principal = c.get("protectedRouteGuardPrincipal")
  if (!principal) return undefined

  const state = guardState.get(principal)
  if (!state) return undefined

  const trustedClient = isTrustedClient(c.req.header("user-agent"))
  return analyzeBehavior(state, Date.now(), {
    userAgent: c.req.header("user-agent"),
    trustedClient,
  })
}
