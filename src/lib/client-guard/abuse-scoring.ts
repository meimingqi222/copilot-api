import { logger } from "~/lib/logger"

import type {
  ClientSnapshot,
  SuspiciousAssessment,
  SuspiciousSignal,
} from "./types"

import {
  AUTH_FAILURE_THRESHOLD,
  AUTO_BLOCK_SCORE_THRESHOLD,
  BURST_REQUEST_THRESHOLD,
  BURST_WINDOW_MS,
  ERROR_RATE_THRESHOLD,
  HIGH_FREQUENCY_THRESHOLD,
  PATH_SCANNING_THRESHOLD,
  RECENT_REQUEST_THRESHOLD,
} from "./state"
import { isKnownUA } from "./ua-whitelist"

export function detectSuspicious(snap: ClientSnapshot): SuspiciousAssessment {
  const reasons: Array<string> = []
  let score = 0

  const now = Date.now()
  const errorRate = snap.requests > 0 ? snap.errors / snap.requests : 0
  const burstRequests = countRecent(snap.recentRequests, now - BURST_WINDOW_MS)
  const recentRequests = snap.recentRequests.length
  const distinctPaths = snap.paths.size

  for (const signal of [
    getUnknownUaSignal(snap),
    getHighErrorRateSignal(snap, errorRate),
    getHighFrequencySignal(snap, recentRequests),
    getBurstTrafficSignal(burstRequests),
    getNoAuthSignal(snap),
    getAuthFailureSignal(snap),
    getPathScanningSignal(snap, distinctPaths),
  ]) {
    if (!signal) continue
    reasons.push(signal.reason)
    score += signal.score
  }

  const suspicious = reasons.length > 0
  const riskLevel = getRiskLevel(score)
  const recommendedAction = getRecommendedAction(score)

  return {
    suspicious,
    reasons,
    score: Math.min(score, 100),
    riskLevel,
    recommendedAction,
    errorRate,
    burstRequests,
    recentRequests,
  }
}

function getUnknownUaSignal(
  snap: ClientSnapshot,
): SuspiciousSignal | undefined {
  if (snap.type !== "ua" || isKnownUA(snap.key)) return undefined
  return { reason: "unknown_ua", score: 15 }
}

function getHighErrorRateSignal(
  snap: ClientSnapshot,
  errorRate: number,
): SuspiciousSignal | undefined {
  if (snap.requests < 10 || errorRate < ERROR_RATE_THRESHOLD) return undefined
  const nonAuthErrors = snap.errors - snap.authFailures
  const nonAuthErrorRate = snap.requests > 0 ? nonAuthErrors / snap.requests : 0
  // If failures are mostly non-auth related (e.g. upstream 5xx or timeouts),
  // assign a lower suspicious score to avoid false-positive blocking of valid clients.
  const isNonAuth =
    nonAuthErrorRate > ERROR_RATE_THRESHOLD
    && snap.authFailures < AUTH_FAILURE_THRESHOLD
  const score = !isNonAuth && errorRate >= 0.6 ? 30 : 18
  return { reason: "high_error_rate", score }
}

function getHighFrequencySignal(
  snap: ClientSnapshot,
  recentRequests: number,
): SuspiciousSignal | undefined {
  if (
    snap.requests < HIGH_FREQUENCY_THRESHOLD
    && recentRequests < RECENT_REQUEST_THRESHOLD
  ) {
    return undefined
  }
  return {
    reason: "high_frequency",
    score: snap.requests >= HIGH_FREQUENCY_THRESHOLD * 2 ? 25 : 15,
  }
}

function getBurstTrafficSignal(
  burstRequests: number,
): SuspiciousSignal | undefined {
  if (burstRequests < BURST_REQUEST_THRESHOLD) return undefined
  return {
    reason: "burst_traffic",
    score: burstRequests >= BURST_REQUEST_THRESHOLD * 2 ? 30 : 22,
  }
}

function getNoAuthSignal(snap: ClientSnapshot): SuspiciousSignal | undefined {
  if (snap.requests < 10 || snap.usernames.size > 0) return undefined
  return { reason: "no_auth", score: 12 }
}

function getAuthFailureSignal(
  snap: ClientSnapshot,
): SuspiciousSignal | undefined {
  if (snap.authFailures < AUTH_FAILURE_THRESHOLD) return undefined
  return {
    reason: "auth_failures",
    score: snap.authFailures >= AUTH_FAILURE_THRESHOLD * 2 ? 35 : 24,
  }
}

function getPathScanningSignal(
  snap: ClientSnapshot,
  distinctPaths: number,
): SuspiciousSignal | undefined {
  if (snap.notFounds < PATH_SCANNING_THRESHOLD || distinctPaths < 6) {
    return undefined
  }
  return { reason: "path_scanning", score: 24 }
}

function getRiskLevel(score: number): "low" | "medium" | "high" | "critical" {
  if (score >= 80) return "critical"
  if (score >= 55) return "high"
  if (score >= 30) return "medium"
  return "low"
}

function getRecommendedAction(
  score: number,
): "allow" | "review" | "temporary_block" {
  if (score >= AUTO_BLOCK_SCORE_THRESHOLD) return "temporary_block"
  if (score >= 30) return "review"
  return "allow"
}

function getGlobalAutoBlockReasons(reasons: Array<string>): Array<string> {
  return reasons.filter((reason) =>
    ["auth_failures", "burst_traffic", "path_scanning"].includes(reason),
  )
}

function shouldAutoBlockGlobally(
  snap: ClientSnapshot,
  assessment: SuspiciousAssessment,
): boolean {
  if (snap.blocked || snap.type !== "ip") {
    return false
  }

  if (assessment.score < AUTO_BLOCK_SCORE_THRESHOLD) {
    return false
  }

  return getGlobalAutoBlockReasons(assessment.reasons).length > 0
}

function isLocalhostAddress(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1"
}

export function checkAutoBlock(
  snap: ClientSnapshot,
  assessment: SuspiciousAssessment,
): void {
  if (isLocalhostAddress(snap.key)) return
  // Auto-block disabled — behind a reverse proxy all users share the same IP,
  // so IP-based auto-blocking causes collateral damage. Manual blacklisting
  // via the admin dashboard and per-principal protected-route-guard still apply.
  if (!shouldAutoBlockGlobally(snap, assessment)) {
    return
  }

  const triggerReasons = getGlobalAutoBlockReasons(assessment.reasons)
  logger.warn(
    `⚠ Guard detected suspicious IP ${snap.key}: score=${assessment.score}, reasons=${triggerReasons.join(", ")}, risk=${assessment.riskLevel} (auto-block disabled)`,
  )
}

function countRecent(values: Array<number>, cutoff: number): number {
  let count = 0
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] < cutoff) break
    count += 1
  }
  return count
}
