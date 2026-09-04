import type {
  ClientSnapshot,
  ClientSnapshotDTO,
  GuardRecordResult,
  GuardRequestPreview,
  SuspiciousAssessment,
} from "./types"

import { checkAutoBlock, detectSuspicious } from "./abuse-scoring"
import { pruneExpiredBlacklistEntries } from "./blacklist"
import { ensureCleanup } from "./persistence"
import {
  MAX_RECENT_REQUESTS,
  MAX_SNAPSHOT_ENTRIES,
  MAX_SNAPSHOT_PATHS,
  MAX_SNAPSHOT_USERNAMES,
  RECENT_WINDOW_MS,
  ipBlacklist,
  ipSnapshots,
  uaBlacklist,
  uaSnapshots,
} from "./state"

// ── Snapshot tracking ──────────────────────────────────────────

export function recordRequest(opts: {
  ip?: string
  ua?: string
  username?: string
  path: string
  isError: boolean
  initiator?: string
  statusCode?: number
  requestPreview?: string
}): GuardRecordResult {
  ensureCleanup()
  const now = Date.now()
  let result: GuardRecordResult = {
    shouldCapturePreview: false,
    blocked: false,
    riskLevel: "low",
  }

  if (opts.ip) {
    result = mergeRecordResult(
      result,
      updateSnapshot(ipSnapshots, {
        key: opts.ip,
        type: "ip",
        username: opts.username,
        path: opts.path,
        isError: opts.isError,
        initiator: opts.initiator,
        statusCode: opts.statusCode,
        requestPreview: opts.requestPreview,
        now,
      }),
    )
  }
  if (opts.ua) {
    result = mergeRecordResult(
      result,
      updateSnapshot(uaSnapshots, {
        key: opts.ua,
        type: "ua",
        username: opts.username,
        path: opts.path,
        isError: opts.isError,
        initiator: opts.initiator,
        statusCode: opts.statusCode,
        requestPreview: opts.requestPreview,
        now,
      }),
    )
  }

  return result
}

export function recordRequestPreview(opts: {
  ip?: string
  ua?: string
  path: string
  statusCode?: number
  preview: string
}): void {
  attachPreview(ipSnapshots, {
    key: opts.ip,
    path: opts.path,
    statusCode: opts.statusCode,
    preview: opts.preview,
  })
  attachPreview(uaSnapshots, {
    key: opts.ua,
    path: opts.path,
    statusCode: opts.statusCode,
    preview: opts.preview,
  })
}

function updateSnapshot(
  map: Map<string, ClientSnapshot>,
  opts: {
    key: string
    type: "ip" | "ua"
    username?: string
    path: string
    isError: boolean
    initiator?: string
    statusCode?: number
    requestPreview?: string
    now: number
  },
): GuardRecordResult {
  const { key, type, now } = opts
  let snap = map.get(key)
  if (!snap) {
    if (map.size >= MAX_SNAPSHOT_ENTRIES) {
      const oldest = map.keys().next().value
      if (typeof oldest === "string") map.delete(oldest)
    }
    snap = {
      key,
      type,
      requests: 0,
      errors: 0,
      authFailures: 0,
      notFounds: 0,
      lastSeenAt: now,
      firstSeenAt: now,
      usernames: new Set(),
      paths: new Map(),
      blocked: false,
      userInitiatorCount: 0,
      agentInitiatorCount: 0,
      recentRequests: [],
      flaggedRequests: [],
    }
    map.set(key, snap)
  }

  snap.requests += 1
  if (opts.isError) snap.errors += 1
  if (opts.statusCode === 401 || opts.statusCode === 403) {
    snap.authFailures += 1
  }
  if (opts.statusCode === 404) {
    snap.notFounds += 1
  }
  snap.lastSeenAt = now
  if (
    opts.username
    && (snap.usernames.has(opts.username)
      || snap.usernames.size < MAX_SNAPSHOT_USERNAMES)
  ) {
    snap.usernames.add(opts.username)
  }
  if (snap.paths.has(opts.path) || snap.paths.size < MAX_SNAPSHOT_PATHS) {
    snap.paths.set(opts.path, (snap.paths.get(opts.path) ?? 0) + 1)
  }

  // Track initiator distribution
  if (opts.initiator === "user") snap.userInitiatorCount += 1
  else if (opts.initiator === "agent") snap.agentInitiatorCount += 1

  snap.recentRequests.push(now)
  trimTimestamps(snap.recentRequests, now - RECENT_WINDOW_MS)
  if (snap.recentRequests.length > MAX_RECENT_REQUESTS) {
    snap.recentRequests.splice(
      0,
      snap.recentRequests.length - MAX_RECENT_REQUESTS,
    )
  }

  // Mark blocked status for display
  const blocklist = type === "ip" ? ipBlacklist : uaBlacklist
  snap.blocked = blocklist.has(key)

  const assessment = detectSuspicious(snap)

  if (opts.requestPreview && shouldStoreRequestPreview(snap, assessment)) {
    pushFlaggedRequest(snap, {
      at: now,
      path: opts.path,
      statusCode: opts.statusCode,
      preview: opts.requestPreview,
    })
  }

  if (snap.type === "ip") {
    checkAutoBlock(snap, assessment)
  }

  return {
    shouldCapturePreview: shouldStoreRequestPreview(snap, assessment),
    blocked: snap.blocked,
    riskLevel: assessment.riskLevel,
  }
}

function mergeRecordResult(
  left: GuardRecordResult,
  right: GuardRecordResult,
): GuardRecordResult {
  return {
    shouldCapturePreview:
      left.shouldCapturePreview || right.shouldCapturePreview,
    blocked: left.blocked || right.blocked,
    riskLevel: getHigherRiskLevel(left.riskLevel, right.riskLevel),
  }
}

function getHigherRiskLevel(
  left: GuardRecordResult["riskLevel"],
  right: GuardRecordResult["riskLevel"],
): GuardRecordResult["riskLevel"] {
  const order = ["low", "medium", "high", "critical"] as const
  return order.indexOf(left) >= order.indexOf(right) ? left : right
}

function trimTimestamps(values: Array<number>, cutoff: number): void {
  while (values.length > 0 && values[0] < cutoff) {
    values.shift()
  }
}

function pushFlaggedRequest(
  snap: ClientSnapshot,
  request: GuardRequestPreview,
): void {
  snap.flaggedRequests.unshift(request)
  if (snap.flaggedRequests.length > 3) {
    snap.flaggedRequests.length = 3
  }
}

function attachPreview(
  map: Map<string, ClientSnapshot>,
  opts: {
    key?: string
    path: string
    statusCode?: number
    preview: string
  },
): void {
  if (!opts.key) {
    return
  }

  const snap = map.get(opts.key)
  if (!snap) {
    return
  }

  const assessment = detectSuspicious(snap)
  if (!shouldStoreRequestPreview(snap, assessment)) {
    return
  }

  pushFlaggedRequest(snap, {
    at: Date.now(),
    path: opts.path,
    statusCode: opts.statusCode,
    preview: opts.preview,
  })
}

function shouldStoreRequestPreview(
  snap: ClientSnapshot,
  assessment: SuspiciousAssessment,
): boolean {
  return snap.blocked || assessment.riskLevel !== "low"
}

function toDTO(snap: ClientSnapshot): ClientSnapshotDTO {
  const assessment = detectSuspicious(snap)
  const topPaths = [...snap.paths.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([path, count]) => ({ path, count }))

  return {
    key: snap.key,
    type: snap.type,
    requests: snap.requests,
    errors: snap.errors,
    authFailures: snap.authFailures,
    notFounds: snap.notFounds,
    lastSeenAt: snap.lastSeenAt,
    firstSeenAt: snap.firstSeenAt,
    usernames: [...snap.usernames],
    paths: Object.fromEntries(snap.paths),
    topPaths,
    flaggedRequests: [...snap.flaggedRequests],
    blocked: snap.blocked,
    suspicious: assessment.suspicious,
    suspiciousReasons: assessment.reasons,
    suspiciousScore: assessment.score,
    riskLevel: assessment.riskLevel,
    recommendedAction: assessment.recommendedAction,
    errorRate: assessment.errorRate,
    burstRequests: assessment.burstRequests,
    recentRequests: assessment.recentRequests,
    userInitiatorCount: snap.userInitiatorCount,
    agentInitiatorCount: snap.agentInitiatorCount,
  }
}

export function getSnapshots(type: "ip" | "ua"): Array<ClientSnapshotDTO> {
  pruneExpiredBlacklistEntries()
  const map = type === "ip" ? ipSnapshots : uaSnapshots
  return [...map.values()]
    .map((snap) => {
      const blocklist = snap.type === "ip" ? ipBlacklist : uaBlacklist
      snap.blocked = blocklist.has(snap.key)
      return toDTO(snap)
    })
    .sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? -1 : 1
      if (a.suspiciousScore !== b.suspiciousScore) {
        return b.suspiciousScore - a.suspiciousScore
      }
      return b.requests - a.requests
    })
}
