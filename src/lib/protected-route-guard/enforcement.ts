import { getGuardConfig } from "~/lib/guard-config"
import { logger } from "~/lib/logger"
import { getClientIp } from "~/lib/utils"

import type {
  BehaviorBlockInput,
  EnforceInput,
  PrincipalBehavior,
} from "./types"

import { recordShadowHit } from "./admin"
import { getProbePatterns } from "./patterns"

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

export function enforceActiveBlock(input: EnforceInput): void {
  const { c, principal, state, routeKind, guardInput, now } = input

  const activeBlockMs = (state.blockedUntil ?? 0) - now
  if (activeBlockMs > 0) {
    const status = state.blockStatus ?? 403
    throwLoggedGuardError({
      c,
      principal,
      state,
      routeKind,
      guardInput,
      reason: "active_block",
      retryAfterSeconds: Math.ceil(activeBlockMs / 1000),
      message:
        status === 429 ?
          "Rate limit exceeded due to suspicious behavior patterns detected. Retry later."
        : "Forbidden. Client is temporarily blocked due to suspicious behavior.",
      status,
      errorType: status === 429 ? "rate_limit_error" : "forbidden_error",
    })
  }
}

export function enforceBehaviorBlock(input: BehaviorBlockInput): void {
  const { c, principal, state, routeKind, guardInput, now, behavior } = input
  const cfg = getGuardConfig()

  if (behavior.score < cfg.scoreSoftThreshold) {
    // Review line: suspicious enough to log, not enough to throttle.
    if (behavior.score >= cfg.scoreReviewThreshold) {
      logger.warn(
        `Protected route guard review (no block): ${JSON.stringify({
          principal,
          score: behavior.score,
          breakdown: behavior.breakdown,
        })}`,
      )
    }
    return
  }

  const reasons = behavior.breakdown.map((b) => `${b.signal}=${b.detail}`)
  const reason = `behavior_block:${reasons.join(",") || `score=${behavior.score}`}`

  // Manual-unblock suppression: don't re-block for the same category within
  // the suppress window (avoids封-解-封 loops while the admin investigates).
  const category = reason.split(":")[0]
  if (isSuppressed(state, category, now)) {
    logger.warn(
      `Protected route guard suppressed repeat block: ${JSON.stringify({
        principal,
        reason,
        suppressUntil: state.suppressUntil,
      })}`,
    )
    return
  }

  // Escalation: repeated blocks inside the window bump one level.
  const repeatOffense =
    state.lastBlockAt !== undefined
    && now - state.lastBlockAt < cfg.escalationWindowMs
  const repeatCount = repeatOffense ? state.repeatCount + 1 : 0

  const { level, durationMs } = levelForScore(behavior.score, repeatCount, cfg)

  if (cfg.shadowMode) {
    recordShadowHit(reason)
    logger.warn(
      `Protected route guard shadow block (not enforced): ${JSON.stringify({
        principal,
        reason,
        level,
        score: behavior.score,
      })}`,
    )
    return
  }

  state.blockedUntil = now + durationMs
  state.repeatCount = repeatCount
  state.lastBlockAt = now
  state.blockLevel = level
  state.blockStatus = level === "L2-short" ? 429 : 403

  throwLoggedGuardError({
    c,
    principal,
    state,
    routeKind,
    guardInput,
    reason,
    retryAfterSeconds: Math.ceil(durationMs / 1000),
    message:
      level === "L2-short" ?
        "Rate limit exceeded due to suspicious behavior patterns detected. Retry later."
      : "Forbidden. Client blocked due to suspicious behavior patterns detected.",
    status: level === "L2-short" ? 429 : 403,
    errorType: level === "L2-short" ? "rate_limit_error" : "forbidden_error",
    behavior,
  })
}

function levelForScore(
  score: number,
  repeatCount: number,
  cfg: {
    scoreSevereThreshold: number
    shortBlockMs: number
    tempBlockMs: number
    longBlockMs: number
  },
): { level: string; durationMs: number } {
  if (score >= 90 || repeatCount >= 2) {
    return {
      level: "L4-long",
      durationMs: Math.min(cfg.longBlockMs, 7 * 24 * 60 * 60 * 1000),
    }
  }
  if (score >= cfg.scoreSevereThreshold || repeatCount >= 1) {
    return { level: "L3-standard", durationMs: cfg.tempBlockMs }
  }
  return { level: "L2-short", durationMs: cfg.shortBlockMs }
}

function isSuppressed(
  state: { suppressUntil?: number; suppressKey?: string },
  category: string,
  now: number,
): boolean {
  return Boolean(
    state.suppressUntil
      && state.suppressUntil > now
      && state.suppressKey === category,
  )
}

export function enforceProbeDetection(input: EnforceInput): void {
  const { c, principal, state, routeKind, guardInput, now } = input
  const content = guardInput.messageContent

  if (!content) return

  const matchedPattern = getProbePatterns().find((p) => p.test(content))
  if (!matchedPattern) return

  const reason = `probe_detection:${matchedPattern.source}`
  if (isSuppressed(state, "probe_detection", now)) {
    return
  }

  if (getGuardConfig().shadowMode) {
    recordShadowHit(reason)
    logger.warn(
      `Probe request detected (shadow, not blocked): ${JSON.stringify({
        principal,
        pattern: matchedPattern.source,
        contentPreview: content.slice(0, 100),
      })}`,
    )
    return
  }

  const cfg = getGuardConfig()
  const repeatOffense =
    state.lastBlockAt !== undefined
    && now - state.lastBlockAt < cfg.escalationWindowMs
  state.blockedUntil = now + cfg.tempBlockMs
  state.repeatCount = repeatOffense ? state.repeatCount + 1 : 0
  state.lastBlockAt = now
  state.blockLevel = "L3-standard"
  state.blockStatus = 403

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
    reason,
    retryAfterSeconds: Math.ceil(cfg.tempBlockMs / 1000),
    message: "Forbidden. Client blocked due to probe request pattern detected.",
    status: 403,
    errorType: "forbidden_error",
  })
}

export function throwLoggedGuardError(input: {
  c: EnforceInput["c"]
  principal: string
  state: EnforceInput["state"]
  routeKind: EnforceInput["routeKind"]
  guardInput: EnforceInput["guardInput"]
  reason: string
  retryAfterSeconds: number
  message: string
  status: 403 | 429
  errorType: "forbidden_error" | "rate_limit_error"
  behavior?: PrincipalBehavior
}): never {
  if (
    input.status === 403
    || input.reason.startsWith("behavior_block")
    || input.reason.startsWith("probe_detection")
  ) {
    input.state.blockReason = input.reason
    input.state.blockedAt = Date.now()
    if (input.behavior) input.state.lastBehavior = input.behavior
  }
  try {
    input.c.set("guardRejected" as never, true)
  } catch {
    // Context may already be finalized; rejection logging still applies.
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
  c: EnforceInput["c"]
  principal: string
  state: EnforceInput["state"]
  routeKind: EnforceInput["routeKind"]
  guardInput: EnforceInput["guardInput"]
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

export function emitSuspiciousWarning(
  c: EnforceInput["c"],
  data: {
    principal: string
    state: EnforceInput["state"]
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

function getClientIpFromRequest(c: EnforceInput["c"]): string {
  return getClientIp(c)
}
