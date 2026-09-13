import { getGuardConfig } from "~/lib/guard-config"

import type {
  BehaviorEvent,
  PrincipalBehavior,
  PrincipalGuardState,
  ScoreBreakdown,
} from "./types"

import { detectAutomation, getAutomationPatterns } from "./patterns"
import {
  AUTH_PROBE_WINDOW_MS,
  BEHAVIOR_WINDOW_MS,
  REQUEST_WINDOW_MS,
  UPSTREAM_429_DENSE_WINDOW_MS,
} from "./state"

// Fixed signal weights for the v2 composite score (thresholds tunable via
// guard-config; weights intentionally fixed to keep the policy surface small).
// Single strong signals (failure bursts, persistent repeats) can reach the
// soft (L2 throttle) line alone; hard (L3+) blocks always need a combination.
export const SCORE_WEIGHTS = {
  upstreamDense: 25,
  upstreamTotal: 20,
  burst: 25,
  failureRate: 50,
  repeatedContent: 25,
  repeatedContentPerExtra: 5,
  repeatedContentMax: 50,
  modelEnum: 10,
  authProbe: 25,
} as const

export interface AnalyzeOptions {
  userAgent?: string
  trustedClient: boolean
  currentContentHash?: string
  currentModel?: string
  provider?: string
}

export function analyzeBehavior(
  state: PrincipalGuardState,
  now: number,
  options: AnalyzeOptions,
): PrincipalBehavior {
  const {
    userAgent,
    trustedClient,
    currentContentHash,
    currentModel,
    provider,
  } = options
  const cfg = getGuardConfig()
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
      countRepeatedContent(
        state.events,
        now,
        currentContentHash,
        currentModel,
        cfg.repeatedContentWindowMs,
      )
    : 0

  const modelEnumCount = countDistinctModels(recentEvents)
  const authProbeCount = countAuthProbe(recentEvents, now)

  const breakdown: Array<ScoreBreakdown> = []
  const effectiveFailureThreshold =
    automatedPattern ?
      cfg.failureRateBlockThreshold * 0.7
    : cfg.failureRateBlockThreshold

  if (dense429Count >= cfg.upstream429DenseThreshold) {
    breakdown.push({
      signal: "upstream_429_dense",
      points: SCORE_WEIGHTS.upstreamDense,
      detail: `${dense429Count}/min`,
    })
  } else if (upstream429Count >= cfg.upstream429TotalThreshold) {
    breakdown.push({
      signal: "upstream_429_total",
      points: SCORE_WEIGHTS.upstreamTotal,
      detail: `${upstream429Count}/10min`,
    })
  }
  if (burstScore >= cfg.burstBlockThreshold) {
    breakdown.push({
      signal: "burst",
      points: SCORE_WEIGHTS.burst,
      detail: `score=${burstScore}`,
    })
  }
  if (failureRate >= effectiveFailureThreshold) {
    breakdown.push({
      signal: "failure_rate",
      points: SCORE_WEIGHTS.failureRate,
      detail: `${(failureRate * 100).toFixed(1)}%${automatedPattern ? "+automation" : ""}`,
    })
  }
  const repeatedActive =
    repeatedContentCount >= cfg.repeatedContentThreshold
    && (!userAgent || getAutomationPatterns().some((p) => p.test(userAgent)))
  if (repeatedActive) {
    // Persistent repeaters escalate: base points plus per extra repeat up to
    // the soft-block line, so lone spam eventually throttles but a couple of
    // retries never do.
    const excess = repeatedContentCount - cfg.repeatedContentThreshold
    breakdown.push({
      signal: "repeated_content",
      points: Math.min(
        SCORE_WEIGHTS.repeatedContentMax,
        SCORE_WEIGHTS.repeatedContent
          + Math.max(0, excess) * SCORE_WEIGHTS.repeatedContentPerExtra,
      ),
      detail: `${repeatedContentCount}x`,
    })
  }
  if (modelEnumCount >= cfg.modelEnumThreshold) {
    breakdown.push({
      signal: "model_enum",
      points: SCORE_WEIGHTS.modelEnum,
      detail: `${modelEnumCount} models/10min`,
    })
  }
  if (authProbeCount >= cfg.authProbeThreshold) {
    breakdown.push({
      signal: "auth_probe",
      points: SCORE_WEIGHTS.authProbe,
      detail: `${authProbeCount}/5min`,
    })
  }

  const score = Math.min(
    100,
    breakdown.reduce((sum, b) => sum + b.points, 0),
  )

  return {
    upstream429TotalCount: upstream429Count,
    upstream429DenseCount: dense429Count,
    burstScore,
    failureRate,
    automatedPattern,
    repeatedContentCount,
    modelEnumCount,
    authProbeCount,
    score,
    breakdown,
  }
}

export function calculateBurstScore(
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

export function calculateFailureRate(
  recentEvents: Array<BehaviorEvent>,
): number {
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

export function countRepeatedContent(
  events: Array<BehaviorEvent>,
  now: number,
  currentContentHash: string,
  currentModel: string | undefined,
  windowMs: number,
): number {
  const windowStart = now - windowMs
  return events.filter(
    (e) =>
      e.at >= windowStart
      && e.contentHash === currentContentHash
      // Same prompt benchmarked across many models is legitimate testing —
      // only count repeats against the same model (or legacy events/models
      // missing on either side, which still count).
      && (!e.model || !currentModel || e.model === currentModel),
  ).length
}

export function countDistinctModels(
  recentEvents: Array<BehaviorEvent>,
): number {
  const models = new Set<string>()
  for (const e of recentEvents) {
    if (e.model) models.add(e.model)
  }
  return models.size
}

export function countAuthProbe(
  recentEvents: Array<BehaviorEvent>,
  now: number,
): number {
  const windowStart = now - AUTH_PROBE_WINDOW_MS
  return recentEvents.filter(
    (e) =>
      e.at >= windowStart
      && e.type === "error"
      && (e.status === 401 || e.status === 403),
  ).length
}
