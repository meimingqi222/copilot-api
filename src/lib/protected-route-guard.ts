import type { Context } from "hono"

import { createHash } from "node:crypto"

import type { ProtectedRouteKind } from "~/lib/protected-routes"

import { HTTPError } from "~/lib/error"
import {
  compilePatterns,
  getGuardConfig,
} from "~/lib/guard-config"
import { logger } from "~/lib/logger"
import { getProtectedRouteKind } from "~/lib/protected-routes"
import { globalTimers } from "~/lib/timer-registry"
import { getClientIp } from "~/lib/utils"

type BehaviorEventType = "request" | "upstream_429" | "error" | "success"

interface BehaviorEvent {
  at: number
  type: BehaviorEventType
  path?: string
  model?: string
  contentHash?: string
}

export interface PrincipalBehavior {
  upstream429TotalCount: number
  upstream429DenseCount: number
  burstScore: number
  failureRate: number
  automatedPattern: boolean
  repeatedContentCount: number
}

export interface PrincipalGuardState {
  events: Array<BehaviorEvent>
  recentRequests: Array<number>
  warned: boolean
  blockedUntil?: number
  lastSeen: number
  lastClientIp?: string
  lastUserAgent?: string
  lastPath?: string
  lastModel?: string
  lastRouteKind?: string
  blockReason?: string
  blockedAt?: number
  lastBehavior?: PrincipalBehavior
}

export interface TempBlockInfo {
  principal: string
  kind: "user" | "key" | "ip"
  userId?: string
  clientIp?: string
  userAgent?: string
  path?: string
  model?: string
  routeKind?: string
  reason?: string
  behavior?: PrincipalBehavior
  blockedUntil: number
  blockedAt?: number
  retryAfterSeconds: number
  recentRequestCount: number
  lastSeen: number
}

interface GuardInput {
  routeKind?: ProtectedRouteKind
  model?: string
  maxTokens?: number
  stream?: boolean
  trustedClient?: boolean
  messageContent?: string
  /** Selected provider kind — automation detection skips non-Copilot routes. */
  provider?: string
}

const guardState = new Map<string, PrincipalGuardState>()

const BEHAVIOR_WINDOW_MS = 10 * 60 * 1000
const REQUEST_WINDOW_MS = 60_000

const UPSTREAM_429_DENSE_WINDOW_MS = 60_000

const REPEATED_CONTENT_WINDOW_MS = 24 * 60 * 60 * 1000

const CLEANUP_INTERVAL_MS = 5 * 60_000

function idleTtlMs(): number {
  return getGuardConfig().tempBlockMs + BEHAVIOR_WINDOW_MS
}

function getTrustedPatterns(): Array<RegExp> {
  return compilePatterns(getGuardConfig().trustedClientPatterns)
}

function getAutomationPatterns(): Array<RegExp> {
  return compilePatterns(getGuardConfig().automationPatterns)
}

function getProbePatterns(): Array<RegExp> {
  return compilePatterns(getGuardConfig().probePatterns)
}

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

  enforceRequestLimit({
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

  const state = guardState.get(principal)
  if (!state) return

  state.events.push({
    at: Date.now(),
    type: "error",
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

function analyzeBehavior(
  state: PrincipalGuardState,
  now: number,
  options: {
    userAgent?: string
    trustedClient: boolean
    currentContentHash?: string
    provider?: string
  },
): PrincipalBehavior {
  const { userAgent, trustedClient, currentContentHash, provider } = options
  const windowStart = now - BEHAVIOR_WINDOW_MS
  const recentEvents = state.events.filter((e) => e.at >= windowStart)

  const upstream429Count = recentEvents.filter(
    (e) => e.type === "upstream_429",
  ).length

  const denseWindowStart = now - UPSTREAM_429_DENSE_WINDOW_MS
  const dense429Count = recentEvents.filter(
    (e) => e.type === "upstream_429" && e.at >= denseWindowStart,
  ).length

  const burstScore = calculateBurstScore(state.recentRequests, now)

  const failureRate = calculateFailureRate(recentEvents)

  // Only detect automation/initiator for Copilot — other providers
  // have their own rate limits and no User/Agent initiator distinction.
  let automatedPattern = false
  if ((!provider || provider === "copilot") && !trustedClient) {
    automatedPattern = detectAutomation(userAgent, state.recentRequests)
  }

  const repeatedContentCount =
    currentContentHash ?
      countRepeatedContent(state.events, now, currentContentHash)
    : 0

  return {
    upstream429TotalCount: upstream429Count,
    upstream429DenseCount: dense429Count,
    burstScore,
    failureRate,
    automatedPattern,
    repeatedContentCount,
  }
}

function calculateBurstScore(
  recentRequests: Array<number>,
  now: number,
): number {
  const windowStart = now - REQUEST_WINDOW_MS
  const requestsInWindow = recentRequests.filter((t) => t >= windowStart)
  const count = requestsInWindow.length

  if (count < 10) return 0

  if (count >= 100) return 100

  const intervals: Array<number> = []
  for (let i = 1; i < requestsInWindow.length; i++) {
    const diff = requestsInWindow[i] - requestsInWindow[i - 1]
    if (diff > 0 && diff < 10_000) {
      intervals.push(diff)
    }
  }

  if (intervals.length < 5) return count

  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length
  const variance =
    intervals.reduce((sum, i) => sum + (i - avgInterval) ** 2, 0)
    / intervals.length
  const stdDev = Math.sqrt(variance)

  const regularityScore = stdDev < avgInterval * 0.2 ? 30 : 0

  return count + regularityScore
}

function calculateFailureRate(recentEvents: Array<BehaviorEvent>): number {
  const outcomes = recentEvents.filter(
    (e) =>
      e.type === "success" || e.type === "error" || e.type === "upstream_429",
  )

  if (outcomes.length < getGuardConfig().minSamplesFailureRate) return 0

  const failures = outcomes.filter(
    (e) => e.type === "error" || e.type === "upstream_429",
  ).length

  return failures / outcomes.length
}

function countRepeatedContent(
  events: Array<BehaviorEvent>,
  now: number,
  currentContentHash: string,
): number {
  const windowStart = now - REPEATED_CONTENT_WINDOW_MS
  return events.filter(
    (e) => e.at >= windowStart && e.contentHash === currentContentHash,
  ).length
}

function detectAutomation(
  userAgent: string | undefined,
  recentRequests: Array<number>,
): boolean {
  if (getAutomationPatterns().some((p) => p.test(userAgent ?? ""))) {
    return true
  }

  if (recentRequests.length >= 20) {
    const intervals: Array<number> = []
    for (let i = 1; i < recentRequests.length; i++) {
      const diff = recentRequests[i] - recentRequests[i - 1]
      if (diff > 0 && diff < 5000) {
        intervals.push(diff)
      }
    }

    if (intervals.length >= 10) {
      const avgInterval =
        intervals.reduce((a, b) => a + b, 0) / intervals.length
      const variance =
        intervals.reduce((sum, i) => sum + (i - avgInterval) ** 2, 0)
        / intervals.length
      const stdDev = Math.sqrt(variance)

      if (stdDev < 50 && avgInterval < 2000) return true
    }
  }

  return false
}

function enforceRequestLimit(input: {
  c: Context
  principal: string
  state: PrincipalGuardState
  routeKind: ProtectedRouteKind
  guardInput: GuardInput
  now: number
}): void {
  const { c, principal, state, routeKind, guardInput, now } = input
  const cfg = getGuardConfig()
  const requestLimit =
    guardInput.trustedClient ? cfg.trustedRequestLimit : cfg.requestLimit

  if (state.recentRequests.length >= requestLimit) {
    const retryAfterSeconds = Math.ceil(
      ((state.recentRequests[0] ?? now) + REQUEST_WINDOW_MS - now) / 1000,
    )
    throwLoggedGuardError({
      c,
      principal,
      state,
      routeKind,
      guardInput,
      reason: "request_limit_window",
      retryAfterSeconds,
      message: `Rate limit exceeded. Maximum ${requestLimit} requests per ${REQUEST_WINDOW_MS / 1000} seconds. Retry after ${retryAfterSeconds}s.`,
      status: 429,
      errorType: "rate_limit_error",
    })
  }
}

function enforceActiveBlock(input: {
  c: Context
  principal: string
  state: PrincipalGuardState
  routeKind: ProtectedRouteKind
  guardInput: GuardInput
  now: number
}): void {
  const { c, principal, state, routeKind, guardInput, now } = input

  const activeBlockMs = (state.blockedUntil ?? 0) - now
  if (activeBlockMs > 0) {
    throwLoggedGuardError({
      c,
      principal,
      state,
      routeKind,
      guardInput,
      reason: "active_block",
      retryAfterSeconds: Math.ceil(activeBlockMs / 1000),
      message:
        "Forbidden. Client is temporarily blocked due to suspicious behavior.",
      status: 403,
      errorType: "forbidden_error",
    })
  }
}

function enforceBehaviorBlock(input: {
  c: Context
  principal: string
  state: PrincipalGuardState
  routeKind: ProtectedRouteKind
  guardInput: GuardInput
  now: number
  behavior: PrincipalBehavior
}): void {
  const { c, principal, state, routeKind, guardInput, now, behavior } = input
  const cfg = getGuardConfig()

  const effectiveFailureThreshold =
    behavior.automatedPattern ?
      cfg.failureRateBlockThreshold * 0.7
    : cfg.failureRateBlockThreshold

  const hasDense429 =
    behavior.upstream429DenseCount >= cfg.upstream429DenseThreshold
  const hasTotal429 =
    behavior.upstream429TotalCount >= cfg.upstream429TotalThreshold

  const userAgent = c.req.header("user-agent")
  const hasRepeatedContent =
    behavior.repeatedContentCount >= cfg.repeatedContentThreshold
    && (!userAgent || getAutomationPatterns().some((p) => p.test(userAgent)))

  const shouldBlock =
    hasDense429
    || hasTotal429
    || behavior.burstScore >= cfg.burstBlockThreshold
    || behavior.failureRate >= effectiveFailureThreshold
    || hasRepeatedContent

  if (!shouldBlock) return

  const reasons: Array<string> = []
  if (hasDense429) {
    reasons.push(`upstream_429_dense=${behavior.upstream429DenseCount}/min`)
  }
  if (hasTotal429) {
    reasons.push(`upstream_429_total=${behavior.upstream429TotalCount}/10min`)
  }
  if (behavior.burstScore >= cfg.burstBlockThreshold) {
    reasons.push(`burst_score=${behavior.burstScore}`)
  }
  if (behavior.failureRate >= effectiveFailureThreshold) {
    const automationNote = behavior.automatedPattern ? "+automation" : ""
    reasons.push(
      `failure_rate=${(behavior.failureRate * 100).toFixed(1)}%${automationNote}`,
    )
  }
  if (hasRepeatedContent) {
    reasons.push(
      `repeated_content=${behavior.repeatedContentCount}x,ua=${userAgent ? "automation" : "none"}`,
    )
  }

  state.blockedUntil = now + cfg.tempBlockMs

  throwLoggedGuardError({
    c,
    principal,
    state,
    routeKind,
    guardInput,
    reason: `behavior_block:${reasons.join(",")}`,
    retryAfterSeconds: Math.ceil(cfg.tempBlockMs / 1000),
    message:
      "Forbidden. Client blocked due to suspicious behavior patterns detected.",
    status: 403,
    errorType: "forbidden_error",
    behavior,
  })
}

function enforceProbeDetection(input: {
  c: Context
  principal: string
  state: PrincipalGuardState
  routeKind: ProtectedRouteKind
  guardInput: GuardInput
  now: number
}): void {
  const { c, principal, state, routeKind, guardInput, now } = input
  const content = guardInput.messageContent

  if (!content) return

  const matchedPattern = getProbePatterns().find((p) => p.test(content))
  if (!matchedPattern) return

  const tempBlockMs = getGuardConfig().tempBlockMs
  state.blockedUntil = now + tempBlockMs

  logger.warn(
    `Probe request detected and blocked: ${JSON.stringify({
      principal,
      pattern: matchedPattern.source,
      contentPreview: content.slice(0, 100),
    })}`,
  )

  throwLoggedGuardError({
    c,
    principal,
    state,
    routeKind,
    guardInput,
    reason: `probe_detection:${matchedPattern.source}`,
    retryAfterSeconds: Math.ceil(tempBlockMs / 1000),
    message: "Forbidden. Client blocked due to probe request pattern detected.",
    status: 403,
    errorType: "forbidden_error",
  })
}

function getOrCreateState(principal: string): PrincipalGuardState {
  let state = guardState.get(principal)
  if (state) {
    return state
  }

  state = { events: [], recentRequests: [], warned: false, lastSeen: 0 }
  guardState.set(principal, state)
  return state
}

function ensureCleanup(): void {
  if (cleanupTimer) {
    return
  }

  cleanupTimer = globalTimers.interval(() => {
    cleanupIdleState(Date.now())
  }, CLEANUP_INTERVAL_MS)
}

function pruneState(state: PrincipalGuardState, now: number): void {
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

function emitSuspiciousWarning(
  c: Context,
  data: {
    principal: string
    state: PrincipalGuardState
    behavior: PrincipalBehavior
  },
): void {
  const { state, behavior } = data
  if (state.warned) return

  const isSuspicious =
    behavior.upstream429DenseCount >= 2
    || behavior.upstream429TotalCount >= 5
    || behavior.burstScore >= 50
    || behavior.automatedPattern

  if (!isSuspicious) return

  state.warned = true
  const ip = getClientIpFromRequest(c)
  const ua = c.req.header("user-agent") || "unknown"

  logger.warn(
    `Suspicious activity detected: ${JSON.stringify({
      principal: data.principal,
      behavior,
      ip,
      userAgent: ua,
      recentRequestCount: state.recentRequests.length,
    })}`,
  )
}

function throwLoggedGuardError(input: {
  c: Context
  principal: string
  state: PrincipalGuardState
  routeKind: ProtectedRouteKind
  guardInput: GuardInput
  reason: string
  retryAfterSeconds: number
  message: string
  status: 403 | 429
  errorType: "forbidden_error" | "rate_limit_error"
  behavior?: PrincipalBehavior
}): never {
  if (input.status === 403) {
    input.state.blockReason = input.reason
    input.state.blockedAt = Date.now()
    if (input.behavior) input.state.lastBehavior = input.behavior
  }
  logGuardRejection(input)
  throw new ProtectedRouteGuardError({
    message: input.message,
    status: input.status,
    errorType: input.errorType,
    retryAfterSeconds: input.retryAfterSeconds,
  })
}

function logGuardRejection(input: {
  c: Context
  principal: string
  state: PrincipalGuardState
  routeKind: ProtectedRouteKind
  guardInput: GuardInput
  reason: string
  retryAfterSeconds: number
  behavior?: PrincipalBehavior
}): void {
  const {
    c,
    principal,
    state,
    routeKind,
    guardInput,
    reason,
    retryAfterSeconds,
    behavior,
  } = input
  const now = Date.now()
  const activeBlockSeconds = Math.max(
    0,
    Math.ceil(((state.blockedUntil ?? 0) - now) / 1000),
  )

  logger.warn(
    `Protected route guard rejected request: ${JSON.stringify({
      reason,
      path: c.req.path,
      routeKind,
      principal,
      model: guardInput.model,
      retryAfterSeconds,
      recentRequestCount: state.recentRequests.length,
      activeBlockSeconds,
      behavior,
      clientIp: getClientIpFromRequest(c),
      userAgent: c.req.header("user-agent") || "unknown",
    })}`,
  )
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

export function resetProtectedRouteGuardForTest(): void {
  guardState.clear()
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = undefined
  }
}

function cleanupIdleState(now: number): void {
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

function isTrustedClient(userAgent: string | undefined): boolean {
  if (!userAgent) {
    return false
  }
  return getTrustedPatterns().some((pattern) => pattern.test(userAgent))
}

function parsePrincipal(principal: string): TempBlockInfo["kind"] {
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
    })
  }
  return out.sort((a, b) => b.blockedUntil - a.blockedUntil)
}

export function unblockPrincipal(principal: string): boolean {
  const state = guardState.get(principal)
  if (!state) return false
  const hadBlock = (state.blockedUntil ?? 0) > Date.now()
  state.blockedUntil = undefined
  state.blockReason = undefined
  state.blockedAt = undefined
  return hadBlock || true
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
