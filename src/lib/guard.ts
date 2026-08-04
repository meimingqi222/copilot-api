import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { Repository } from "~/lib/repository"
import { globalTimers } from "~/lib/timer-registry"

// ── Types ──────────────────────────────────────────────────────

export interface BlacklistEntry {
  /** The blocked value (IP address or User-Agent substring) */
  value: string
  type: "ip" | "ua"
  /** Human-readable reason */
  reason?: string
  /** Manual block or auto mitigation */
  source?: "manual" | "auto"
  /** Temporary auto blocks expire automatically */
  expiresAt?: number
  /** Risk score when the auto action was triggered */
  triggerScore?: number
  /** Machine-readable reasons that triggered the action */
  triggerReasons?: Array<string>
  /** When the entry was created (epoch ms) */
  createdAt: number
}

export interface ClientSnapshot {
  /** Unique key: ip or ua string */
  key: string
  type: "ip" | "ua"
  /** Total requests seen in the current tracking window */
  requests: number
  /** Requests that returned 4xx/5xx */
  errors: number
  /** Authentication failures (401/403) */
  authFailures: number
  /** 404 responses, usually probing or scanning */
  notFounds: number
  /** Last request timestamp */
  lastSeenAt: number
  /** First request timestamp in window */
  firstSeenAt: number
  /** Associated usernames (from auth) */
  usernames: Set<string>
  /** Associated paths */
  paths: Map<string, number>
  /** Whether this entry is currently blacklisted */
  blocked: boolean
  /** Count of requests where initiator was 'user' (premium) */
  userInitiatorCount: number
  /** Count of requests where initiator was 'agent' (non-premium) */
  agentInitiatorCount: number
  /** Recent timestamps used for burst detection */
  recentRequests: Array<number>
  /** Last suspicious or blocked request previews */
  flaggedRequests: Array<GuardRequestPreview>
}

export interface GuardRequestPreview {
  at: number
  path: string
  statusCode?: number
  preview: string
}

export interface GuardRecordResult {
  shouldCapturePreview: boolean
  blocked: boolean
  riskLevel: "low" | "medium" | "high" | "critical"
}

interface GuardPersistence {
  blacklist?: Array<BlacklistEntry>
  uaWhitelist?: Array<string>
}

interface SuspiciousAssessment {
  suspicious: boolean
  reasons: Array<string>
  score: number
  riskLevel: "low" | "medium" | "high" | "critical"
  recommendedAction: "allow" | "review" | "temporary_block"
  errorRate: number
  burstRequests: number
  recentRequests: number
}

interface SuspiciousSignal {
  reason: string
  score: number
}

// ── Known UA patterns (built-in) ──────────────────────────────

const BUILTIN_UA_PATTERNS = [
  "vscode",
  "visual studio code",
  "cursor",
  "windsurf",
  "claude-code",
  "codebuff",
  "copilot",
  "github",
  "jetbrains",
  "neovim",
  "vim",
  "emacs",
  "sublime",
  "helix",
  "zed",
  "cline",
  "continue",
  "aider",
  "crush",
  "openai",
  "anthropic",
]

const customUaWhitelist: Array<string> = []

function isKnownUA(ua: string): boolean {
  const lower = ua.toLowerCase()
  for (const pattern of BUILTIN_UA_PATTERNS) {
    if (lower.includes(pattern)) return true
  }
  for (const pattern of customUaWhitelist) {
    if (lower.includes(pattern.toLowerCase())) return true
  }
  return false
}

// Suspicious thresholds
const ERROR_RATE_THRESHOLD = 0.3
const HIGH_FREQUENCY_THRESHOLD = 100
const AUTH_FAILURE_THRESHOLD = 8
const PATH_SCANNING_THRESHOLD = 8
const BURST_WINDOW_MS = 60_000
const BURST_REQUEST_THRESHOLD = 20
const RECENT_WINDOW_MS = 10 * 60 * 1000
const RECENT_REQUEST_THRESHOLD = 60
const AUTO_BLOCK_SCORE_THRESHOLD = 80
const AUTO_BLOCK_DURATION_MS = 60 * 60 * 1000
const AUTO_BLOCK_DURATION_SEVERE_MS = 24 * 60 * 60 * 1000
const MAX_SNAPSHOT_ENTRIES = 10_000
const MAX_SNAPSHOT_PATHS = 256
const MAX_SNAPSHOT_USERNAMES = 256
const MAX_RECENT_REQUESTS = 4_096

// ── In-memory state ────────────────────────────────────────────

const ipBlacklist = new Map<string, BlacklistEntry>()
const uaBlacklist = new Map<string, BlacklistEntry>()

const ipSnapshots = new Map<string, ClientSnapshot>()
const uaSnapshots = new Map<string, ClientSnapshot>()

// Window for aggregation: keep last 24 hours
const SNAPSHOT_WINDOW_MS = 24 * 60 * 60 * 1000
// Cleanup interval: every 10 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

let cleanupTimer: ReturnType<typeof setInterval> | undefined
let persistenceEnabled = true

function ensureCleanup() {
  if (cleanupTimer) return
  cleanupTimer = globalTimers.interval(() => {
    const cutoff = Date.now() - SNAPSHOT_WINDOW_MS
    for (const [key, snap] of ipSnapshots) {
      if (snap.lastSeenAt < cutoff) ipSnapshots.delete(key)
    }
    for (const [key, snap] of uaSnapshots) {
      if (snap.lastSeenAt < cutoff) uaSnapshots.delete(key)
    }

    const removed = pruneExpiredBlacklistEntries()
    if (removed > 0) {
      void saveGuard()
    }
  }, CLEANUP_INTERVAL_MS)
}

// ── Blacklist operations ───────────────────────────────────────

export function isBlocked(opts: {
  ip?: string
  ua?: string
}): BlacklistEntry | null {
  const removed = pruneExpiredBlacklistEntries()
  if (removed > 0) {
    void saveGuard()
  }

  if (opts.ip) {
    const entry = ipBlacklist.get(opts.ip)
    if (entry) return entry
  }
  if (opts.ua) {
    const ua = opts.ua.toLowerCase()
    for (const [pattern, entry] of uaBlacklist) {
      if (ua.includes(pattern.toLowerCase())) return entry
    }
  }
  return null
}

export async function addBlacklistEntry(
  entry: Omit<BlacklistEntry, "createdAt">,
): Promise<BlacklistEntry> {
  const full: BlacklistEntry = {
    ...entry,
    source: entry.source ?? "manual",
    createdAt: Date.now(),
  }
  if (entry.type === "ip") {
    ipBlacklist.set(entry.value, full)
  } else {
    uaBlacklist.set(entry.value, full)
  }
  await saveGuard()
  return full
}

export async function removeBlacklistEntry(opts: {
  value: string
  type: "ip" | "ua"
}): Promise<boolean> {
  const map = opts.type === "ip" ? ipBlacklist : uaBlacklist
  const existed = map.delete(opts.value)
  if (existed) await saveGuard()
  return existed
}

export function getBlacklist(): Array<BlacklistEntry> {
  pruneExpiredBlacklistEntries()
  return [...ipBlacklist.values(), ...uaBlacklist.values()].sort(
    (a, b) => b.createdAt - a.createdAt,
  )
}

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

function countRecent(values: Array<number>, cutoff: number): number {
  let count = 0
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] < cutoff) break
    count += 1
  }
  return count
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

function detectSuspicious(snap: ClientSnapshot): SuspiciousAssessment {
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

function getAutoBlockDuration(
  assessment: SuspiciousAssessment,
  snap: ClientSnapshot,
): number {
  if (
    assessment.burstRequests >= BURST_REQUEST_THRESHOLD * 2
    || snap.authFailures >= AUTH_FAILURE_THRESHOLD * 2
  ) {
    return AUTO_BLOCK_DURATION_SEVERE_MS
  }

  return AUTO_BLOCK_DURATION_MS
}

function isLocalhostAddress(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1"
}

function checkAutoBlock(
  snap: ClientSnapshot,
  assessment: SuspiciousAssessment,
): void {
  if (isLocalhostAddress(snap.key)) return
  if (!shouldAutoBlockGlobally(snap, assessment)) {
    return
  }

  const triggerReasons = getGlobalAutoBlockReasons(assessment.reasons)
  const durationMs = getAutoBlockDuration(assessment, snap)
  const expiresAt = Date.now() + durationMs
  const entry: BlacklistEntry = {
    value: snap.key,
    type: snap.type,
    source: "auto",
    reason: `Auto-blocked (${assessment.riskLevel} risk): ${triggerReasons.join(", ")}`,
    expiresAt,
    triggerScore: assessment.score,
    triggerReasons,
    createdAt: Date.now(),
  }

  ipBlacklist.set(snap.key, entry)
  snap.blocked = true
  logger.warn(
    `⚠ Guard auto-blocked IP ${snap.key}: score=${assessment.score}, reasons=${triggerReasons.join(", ")}, expires=${new Date(expiresAt).toISOString()}`,
  )
  void saveGuard()
}

/** Serializable version of ClientSnapshot for API responses */
export interface ClientSnapshotDTO {
  key: string
  type: "ip" | "ua"
  requests: number
  errors: number
  authFailures: number
  notFounds: number
  lastSeenAt: number
  firstSeenAt: number
  usernames: Array<string>
  paths: Record<string, number>
  topPaths: Array<{ path: string; count: number }>
  flaggedRequests: Array<GuardRequestPreview>
  blocked: boolean
  /** Whether this client looks suspicious */
  suspicious: boolean
  /** Reasons why it's marked suspicious */
  suspiciousReasons: Array<string>
  /** Composite risk score used for UI sorting */
  suspiciousScore: number
  riskLevel: "low" | "medium" | "high" | "critical"
  recommendedAction: "allow" | "review" | "temporary_block"
  errorRate: number
  burstRequests: number
  recentRequests: number
  /** Initiator distribution */
  userInitiatorCount: number
  agentInitiatorCount: number
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

// ── UA Whitelist management ────────────────────────────────────

export function getUaWhitelist(): Array<string> {
  return [...BUILTIN_UA_PATTERNS, ...customUaWhitelist]
}

export function getCustomUaWhitelist(): Array<string> {
  return [...customUaWhitelist]
}

export async function addUaWhitelistPattern(pattern: string): Promise<void> {
  const lower = pattern.toLowerCase().trim()
  if (!lower || customUaWhitelist.includes(lower)) return
  customUaWhitelist.push(lower)
  await saveGuard()
}

export async function removeUaWhitelistPattern(
  pattern: string,
): Promise<boolean> {
  const idx = customUaWhitelist.indexOf(pattern.toLowerCase().trim())
  if (idx === -1) return false
  customUaWhitelist.splice(idx, 1)
  await saveGuard()
  return true
}

// ── Persistence ────────────────────────────────────────────────

const guardRepository = new Repository<GuardPersistence>({
  filePath: () => PATHS.GUARD_PATH,
  serialize: (data) => JSON.stringify(data, null, 2),
  deserialize: (raw) => JSON.parse(raw) as GuardPersistence,
  corruptMessage: "guard.json is corrupt",
})

export async function loadGuard(): Promise<void> {
  try {
    const data = await guardRepository.load()
    if (!data) return
    for (const entry of data.blacklist || []) {
      if (isExpired(entry)) continue
      const map = entry.type === "ip" ? ipBlacklist : uaBlacklist
      map.set(entry.value, { ...entry, source: entry.source ?? "manual" })
    }
    for (const pattern of data.uaWhitelist || []) {
      if (!customUaWhitelist.includes(pattern)) {
        customUaWhitelist.push(pattern)
      }
    }
    logger.info(
      `Guard loaded: ${ipBlacklist.size} blocked IPs, ${uaBlacklist.size} blocked UAs, ${customUaWhitelist.length} custom UA patterns`,
    )
  } catch {
    // File doesn't exist yet — that's fine
  }
}

function pruneExpiredBlacklistEntries(): number {
  let removed = 0
  for (const [key, entry] of ipBlacklist) {
    if (!isExpired(entry)) continue
    ipBlacklist.delete(key)
    removed += 1
  }
  for (const [key, entry] of uaBlacklist) {
    if (!isExpired(entry)) continue
    uaBlacklist.delete(key)
    removed += 1
  }
  return removed
}

function isExpired(entry: BlacklistEntry): boolean {
  return typeof entry.expiresAt === "number" && entry.expiresAt <= Date.now()
}

async function saveGuard(): Promise<void> {
  if (!persistenceEnabled) return
  await guardRepository.save({
    blacklist: getBlacklist(),
    uaWhitelist: [...customUaWhitelist],
  })
}

export function resetGuardForTest(): void {
  persistenceEnabled = false
  ipBlacklist.clear()
  uaBlacklist.clear()
  ipSnapshots.clear()
  uaSnapshots.clear()
  customUaWhitelist.splice(0)
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = undefined
  }
}
