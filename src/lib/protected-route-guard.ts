import type { Context } from "hono"

import consola from "consola"
import { createHash } from "node:crypto"

import type { ProtectedRouteKind } from "~/lib/protected-routes"

import { getProtectedRouteKind } from "~/lib/protected-routes"

type RiskLevel = "low" | "medium" | "high" | "critical"

interface GuardEvent {
  at: number
  score: number
}

interface PrincipalGuardState {
  recentEvents: Array<GuardEvent>
  recentRequests: Array<number>
  warned: boolean
  cooldownUntil?: number
  blockedUntil?: number
  lastSeen: number
}

interface GuardInput {
  routeKind?: ProtectedRouteKind
  model?: string
  maxTokens?: number
  stream?: boolean
}

const guardState = new Map<string, PrincipalGuardState>()

const WINDOW_MS = 10 * 60 * 1000
const MEDIUM_RISK_THRESHOLD = 30
const COOLDOWN_THRESHOLD = 55
const HIGH_RISK_THRESHOLD = 70
const BLOCK_THRESHOLD = 80

const SHORT_COOLDOWN_MS = 3 * 60 * 1000
const LONG_COOLDOWN_MS = 15 * 60 * 1000
const TEMPORARY_BLOCK_MS = 30 * 60 * 1000
const REQUEST_WINDOW_MS = 60_000
const REQUEST_LIMIT = 30
const ALERT_THRESHOLD = 20
const CLEANUP_INTERVAL_MS = 5 * 60_000
const IDLE_TTL_MS = TEMPORARY_BLOCK_MS + WINDOW_MS

let cleanupTimer: ReturnType<typeof setInterval> | undefined

export class ProtectedRouteGuardError extends Error {
  status: 403 | 429
  errorType: "forbidden_error" | "rate_limit_error"
  retryAfterSeconds: number

  constructor(opts: {
    message: string
    status: 403 | 429
    errorType: "forbidden_error" | "rate_limit_error"
    retryAfterSeconds?: number
  }) {
    super(opts.message)
    this.name = "ProtectedRouteGuardError"
    this.status = opts.status
    this.errorType = opts.errorType
    this.retryAfterSeconds = opts.retryAfterSeconds ?? 0
  }
}

export function checkProtectedRouteGuard(
  c: Context,
  input: GuardInput = {},
): void {
  ensureCleanup()
  const routeKind = input.routeKind ?? getProtectedRouteKind(c.req.path)
  if (!routeKind) {
    return
  }

  const principal = getPrincipalKey(c)
  const now = Date.now()
  const state = getOrCreateState(principal)
  pruneState(state, now)
  state.lastSeen = now

  c.set("protectedRouteGuardPrincipal" as never, principal)

  if (state.recentRequests.length >= REQUEST_LIMIT) {
    const retryAfterSeconds = Math.ceil(
      ((state.recentRequests[0] ?? now) + REQUEST_WINDOW_MS - now) / 1000,
    )
    markPreviewCapture(c, "high")
    throw new ProtectedRouteGuardError({
      message: `Rate limit exceeded. Maximum ${REQUEST_LIMIT} requests per ${REQUEST_WINDOW_MS / 1000} seconds. Retry after ${retryAfterSeconds}s.`,
      status: 429,
      errorType: "rate_limit_error",
      retryAfterSeconds,
    })
  }

  const activeBlockMs = (state.blockedUntil ?? 0) - now
  if (activeBlockMs > 0) {
    markPreviewCapture(c, "critical")
    throw new ProtectedRouteGuardError({
      message:
        "Forbidden. Protected routes are temporarily blocked for this client.",
      status: 403,
      errorType: "forbidden_error",
      retryAfterSeconds: Math.ceil(activeBlockMs / 1000),
    })
  }

  const activeCooldownMs = (state.cooldownUntil ?? 0) - now
  if (activeCooldownMs > 0) {
    markPreviewCapture(c, "high")
    throw new ProtectedRouteGuardError({
      message: "Rate limit exceeded for protected routes. Retry later.",
      status: 429,
      errorType: "rate_limit_error",
      retryAfterSeconds: Math.ceil(activeCooldownMs / 1000),
    })
  }

  state.recentRequests.push(now)
  emitSuspiciousWarning(c, principal, state)

  const requestScore = estimateRequestScore(routeKind, input)
  const windowScore = state.recentEvents.reduce(
    (total, entry) => total + entry.score,
    0,
  )
  const projectedScore = windowScore + requestScore
  const riskLevel = getRiskLevel(projectedScore)

  c.set("protectedRouteGuardScore" as never, projectedScore)
  c.set("protectedRouteGuardRisk" as never, riskLevel)

  if (projectedScore >= BLOCK_THRESHOLD) {
    // Start a fresh window after the penalty period. Otherwise the stale
    // accumulated score can immediately re-trigger the block on the next call.
    state.recentEvents = []
    state.blockedUntil = now + TEMPORARY_BLOCK_MS
    markPreviewCapture(c, "critical")
    throw new ProtectedRouteGuardError({
      message:
        "Forbidden. Protected routes are temporarily blocked for this client.",
      status: 403,
      errorType: "forbidden_error",
      retryAfterSeconds: Math.ceil(TEMPORARY_BLOCK_MS / 1000),
    })
  }

  if (projectedScore >= HIGH_RISK_THRESHOLD) {
    // Reset the accumulated score when entering cooldown so clients can recover
    // after serving the penalty instead of being re-limited instantly.
    state.recentEvents = []
    state.cooldownUntil = now + LONG_COOLDOWN_MS
    markPreviewCapture(c, "high")
    throw new ProtectedRouteGuardError({
      message: "Rate limit exceeded for protected routes. Retry later.",
      status: 429,
      errorType: "rate_limit_error",
      retryAfterSeconds: Math.ceil(LONG_COOLDOWN_MS / 1000),
    })
  }

  if (projectedScore >= COOLDOWN_THRESHOLD) {
    // Reset the accumulated score when entering cooldown so clients can recover
    // after serving the penalty instead of being re-limited instantly.
    state.recentEvents = []
    state.cooldownUntil = now + SHORT_COOLDOWN_MS
    markPreviewCapture(c, "high")
    throw new ProtectedRouteGuardError({
      message: "Rate limit exceeded for protected routes. Retry later.",
      status: 429,
      errorType: "rate_limit_error",
      retryAfterSeconds: Math.ceil(SHORT_COOLDOWN_MS / 1000),
    })
  }

  state.recentEvents.push({ at: now, score: requestScore })

  if (riskLevel !== "low") {
    markPreviewCapture(c, riskLevel)
  }
}

function getOrCreateState(principal: string): PrincipalGuardState {
  let state = guardState.get(principal)
  if (state) {
    return state
  }

  state = { recentEvents: [], recentRequests: [], warned: false, lastSeen: 0 }
  guardState.set(principal, state)
  return state
}

function ensureCleanup(): void {
  if (cleanupTimer) {
    return
  }

  cleanupTimer = setInterval(() => {
    cleanupIdleState(Date.now())
  }, CLEANUP_INTERVAL_MS)

  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref()
  }
}

function pruneState(state: PrincipalGuardState, now: number): void {
  const cutoff = now - WINDOW_MS
  state.recentEvents = state.recentEvents.filter((entry) => entry.at >= cutoff)
  state.recentRequests = state.recentRequests.filter(
    (timestamp) => timestamp >= now - REQUEST_WINDOW_MS,
  )
  if (state.recentRequests.length === 0) {
    state.warned = false
  }

  if ((state.cooldownUntil ?? 0) <= now) {
    state.cooldownUntil = undefined
  }
  if ((state.blockedUntil ?? 0) <= now) {
    state.blockedUntil = undefined
  }
}

function emitSuspiciousWarning(
  c: Context,
  principal: string,
  state: PrincipalGuardState,
): void {
  if (state.warned || state.recentRequests.length < ALERT_THRESHOLD) {
    return
  }

  state.warned = true
  const ip = getClientIpFromRequest(c)
  const ua = c.req.header("user-agent") || "unknown"
  consola.warn(
    `Suspicious activity: ${principal} made ${state.recentRequests.length} requests in ${REQUEST_WINDOW_MS / 1000}s (IP: ${ip}, UA: ${ua})`,
  )
}

function estimateRequestScore(
  routeKind: ProtectedRouteKind,
  input: GuardInput,
): number {
  if (routeKind === "token") {
    return 8
  }

  const baseScore = 2
  const modelMultiplier = getModelMultiplier(input.model)
  const outputMultiplier = getOutputMultiplier(input.maxTokens)
  const streamMultiplier = input.stream ? 1.1 : 1

  return baseScore * modelMultiplier * outputMultiplier * streamMultiplier
}

function getModelMultiplier(model: string | undefined): number {
  if (!model) {
    return 1.5
  }

  const normalized = model.toLowerCase()
  if (/mini|nano|haiku|flash|4o-mini|gpt-5-mini|gpt-5-nano/.test(normalized)) {
    return 1
  }
  if (/o1|o3|o4|opus|reasoning|gpt-5(?!-mini|-nano)/.test(normalized)) {
    return 3
  }
  return 1.5
}

function getOutputMultiplier(maxTokens: number | undefined): number {
  if (!maxTokens || !Number.isFinite(maxTokens)) {
    return 1
  }
  if (maxTokens >= 16_000) {
    return 1.5
  }
  if (maxTokens >= 8_000) {
    return 1.25
  }
  return 1
}

function getRiskLevel(score: number): RiskLevel {
  if (score >= BLOCK_THRESHOLD) {
    return "critical"
  }
  if (score >= HIGH_RISK_THRESHOLD) {
    return "high"
  }
  if (score >= MEDIUM_RISK_THRESHOLD) {
    return "medium"
  }
  return "low"
}

function markPreviewCapture(
  c: Context,
  riskLevel: Exclude<RiskLevel, "low">,
): void {
  c.set("protectedRouteGuardCapturePreview" as never, true)
  c.set("protectedRouteGuardRisk" as never, riskLevel)
}

function getPrincipalKey(c: Context): string {
  const userId = c.get("userId" as never) as string | undefined
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

  const [scheme, token] = authHeader.split(" ")
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
    return undefined
  }

  return token
}

function getClientIpFromRequest(c: Context): string {
  return (
    c.req.header("cf-connecting-ip")
    || c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip")
    || "unknown"
  )
}

export function resetProtectedRouteGuardForTest(): void {
  guardState.clear()
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = undefined
  }
}

function cleanupIdleState(now: number): void {
  for (const [principal, state] of guardState) {
    pruneState(state, now)
    const hasActivePenalty =
      (state.cooldownUntil ?? 0) > now || (state.blockedUntil ?? 0) > now
    const hasRecentActivity =
      state.recentEvents.length > 0 || state.recentRequests.length > 0

    if (hasActivePenalty || hasRecentActivity) {
      continue
    }

    if (now - state.lastSeen >= IDLE_TTL_MS) {
      guardState.delete(principal)
    }
  }
}

export function cleanupProtectedRouteGuardForTest(now = Date.now()): void {
  cleanupIdleState(now)
}

export function getProtectedRouteGuardSizeForTest(): number {
  return guardState.size
}
