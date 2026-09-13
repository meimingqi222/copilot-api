import type { Context } from "hono"

import type { ProtectedRouteKind } from "~/lib/protected-routes"

export type BehaviorEventType = "request" | "upstream_429" | "error" | "success"

export interface BehaviorEvent {
  at: number
  type: BehaviorEventType
  path?: string
  model?: string
  contentHash?: string
  status?: number
}

export interface ScoreBreakdown {
  signal: string
  points: number
  detail: string
}

export interface PrincipalBehavior {
  upstream429TotalCount: number
  upstream429DenseCount: number
  burstScore: number
  failureRate: number
  automatedPattern: boolean
  repeatedContentCount: number
  modelEnumCount: number
  authProbeCount: number
  score: number
  breakdown: Array<ScoreBreakdown>
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
  repeatCount: number
  lastBlockAt?: number
  blockLevel?: string
  suppressUntil?: number
  suppressKey?: string
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
  level?: string
  repeatCount?: number
  score?: number
}

export interface GuardInput {
  routeKind?: ProtectedRouteKind
  model?: string
  maxTokens?: number
  stream?: boolean
  trustedClient?: boolean
  messageContent?: string
  /** Selected provider kind — automation detection skips non-Copilot routes. */
  provider?: string
}

export interface EnforceInput {
  c: Context
  principal: string
  state: PrincipalGuardState
  routeKind: ProtectedRouteKind
  guardInput: GuardInput
  now: number
}

export interface BehaviorBlockInput extends EnforceInput {
  behavior: PrincipalBehavior
}
