import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"

// ── Types ──────────────────────────────────────────────────────

export interface BlacklistEntry {
  /** The blocked value (IP address or User-Agent substring) */
  value: string
  type: "ip" | "ua"
  /** Human-readable reason */
  reason?: string
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
}

interface GuardPersistence {
  blacklist?: Array<BlacklistEntry>
  uaWhitelist?: Array<string>
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
// Auto-block: >= this many user-initiator requests with 0 agent requests
const PREMIUM_ABUSE_THRESHOLD = 30

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

function ensureCleanup() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - SNAPSHOT_WINDOW_MS
    for (const [key, snap] of ipSnapshots) {
      if (snap.lastSeenAt < cutoff) ipSnapshots.delete(key)
    }
    for (const [key, snap] of uaSnapshots) {
      if (snap.lastSeenAt < cutoff) uaSnapshots.delete(key)
    }
  }, CLEANUP_INTERVAL_MS)
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref()
  }
}

// ── Blacklist operations ───────────────────────────────────────

export function isBlocked(opts: {
  ip?: string
  ua?: string
}): BlacklistEntry | null {
  if (opts.ip) {
    const entry = ipBlacklist.get(opts.ip)
    if (entry) return entry
  }
  if (opts.ua) {
    for (const [pattern, entry] of uaBlacklist) {
      if (opts.ua.includes(pattern)) return entry
    }
  }
  return null
}

export async function addBlacklistEntry(
  entry: Omit<BlacklistEntry, "createdAt">,
): Promise<BlacklistEntry> {
  const full: BlacklistEntry = { ...entry, createdAt: Date.now() }
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
  return [...ipBlacklist.values(), ...uaBlacklist.values()]
}

// ── Snapshot tracking ──────────────────────────────────────────

export function recordRequest(opts: {
  ip?: string
  ua?: string
  username?: string
  path: string
  isError: boolean
  initiator?: string
}): void {
  ensureCleanup()
  const now = Date.now()

  if (opts.ip) {
    updateSnapshot(ipSnapshots, {
      key: opts.ip,
      type: "ip",
      username: opts.username,
      path: opts.path,
      isError: opts.isError,
      initiator: opts.initiator,
      now,
    })
  }
  if (opts.ua) {
    updateSnapshot(uaSnapshots, {
      key: opts.ua,
      type: "ua",
      username: opts.username,
      path: opts.path,
      isError: opts.isError,
      initiator: opts.initiator,
      now,
    })
  }
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
    now: number
  },
): void {
  const { key, type, now } = opts
  let snap = map.get(key)
  if (!snap) {
    snap = {
      key,
      type,
      requests: 0,
      errors: 0,
      lastSeenAt: now,
      firstSeenAt: now,
      usernames: new Set(),
      paths: new Map(),
      blocked: false,
      userInitiatorCount: 0,
      agentInitiatorCount: 0,
    }
    map.set(key, snap)
  }

  snap.requests += 1
  if (opts.isError) snap.errors += 1
  snap.lastSeenAt = now
  if (opts.username) snap.usernames.add(opts.username)
  snap.paths.set(opts.path, (snap.paths.get(opts.path) ?? 0) + 1)

  // Track initiator distribution
  if (opts.initiator === "user") snap.userInitiatorCount += 1
  else if (opts.initiator === "agent") snap.agentInitiatorCount += 1

  // Mark blocked status for display
  const blocklist = type === "ip" ? ipBlacklist : uaBlacklist
  snap.blocked = blocklist.has(key)

  // Auto-block: heavy premium abuse (all user-initiator, no agent, high volume)
  checkAutoBlock(snap)
}

function checkAutoBlock(snap: ClientSnapshot): void {
  if (snap.blocked) return
  if (
    snap.userInitiatorCount >= PREMIUM_ABUSE_THRESHOLD
    && snap.agentInitiatorCount === 0
  ) {
    const blocklist = snap.type === "ip" ? ipBlacklist : uaBlacklist
    const entry: BlacklistEntry = {
      value: snap.key,
      type: snap.type,
      reason: `Auto-blocked: ${snap.userInitiatorCount} premium requests with no agent requests`,
      createdAt: Date.now(),
    }
    blocklist.set(snap.key, entry)
    snap.blocked = true
    consola.warn(
      `⚠ Guard auto-blocked ${snap.type} ${snap.key}: ${snap.userInitiatorCount} user-initiator requests, 0 agent`,
    )
    // Best-effort persist (don't await in sync context)
    void saveGuard()
  }
}

/** Serializable version of ClientSnapshot for API responses */
export interface ClientSnapshotDTO {
  key: string
  type: "ip" | "ua"
  requests: number
  errors: number
  lastSeenAt: number
  firstSeenAt: number
  usernames: Array<string>
  paths: Record<string, number>
  blocked: boolean
  /** Whether this client looks suspicious */
  suspicious: boolean
  /** Reasons why it's marked suspicious */
  suspiciousReasons: Array<string>
  /** Initiator distribution */
  userInitiatorCount: number
  agentInitiatorCount: number
}

function detectSuspicious(snap: ClientSnapshot): {
  suspicious: boolean
  reasons: Array<string>
} {
  const reasons: Array<string> = []

  // Unknown UA (only for UA snapshots)
  if (snap.type === "ua" && !isKnownUA(snap.key)) {
    reasons.push("unknown_ua")
  }

  // High error rate (> 30%)
  if (
    snap.requests >= 5
    && snap.errors / snap.requests > ERROR_RATE_THRESHOLD
  ) {
    reasons.push("high_error_rate")
  }

  // High frequency (> 100 requests in window)
  if (snap.requests >= HIGH_FREQUENCY_THRESHOLD) {
    reasons.push("high_frequency")
  }

  // No authenticated user
  if (snap.requests >= 5 && snap.usernames.size === 0) {
    reasons.push("no_auth")
  }

  // Premium abuse: many user-initiator requests, zero agent
  if (snap.userInitiatorCount >= 10 && snap.agentInitiatorCount === 0) {
    reasons.push("premium_abuse")
  }

  return { suspicious: reasons.length > 0, reasons }
}

function toDTO(snap: ClientSnapshot): ClientSnapshotDTO {
  const { suspicious, reasons } = detectSuspicious(snap)
  return {
    key: snap.key,
    type: snap.type,
    requests: snap.requests,
    errors: snap.errors,
    lastSeenAt: snap.lastSeenAt,
    firstSeenAt: snap.firstSeenAt,
    usernames: [...snap.usernames],
    paths: Object.fromEntries(snap.paths),
    blocked: snap.blocked,
    suspicious,
    suspiciousReasons: reasons,
    userInitiatorCount: snap.userInitiatorCount,
    agentInitiatorCount: snap.agentInitiatorCount,
  }
}

export function getSnapshots(type: "ip" | "ua"): Array<ClientSnapshotDTO> {
  const map = type === "ip" ? ipSnapshots : uaSnapshots
  return [...map.values()]
    .map((s) => toDTO(s))
    .sort((a, b) => {
      // Suspicious first, then by requests desc
      if (a.suspicious !== b.suspicious) return a.suspicious ? -1 : 1
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

export async function loadGuard(): Promise<void> {
  try {
    const raw = await fs.readFile(PATHS.GUARD_PATH)
    const data = JSON.parse(raw) as GuardPersistence
    for (const entry of data.blacklist || []) {
      const map = entry.type === "ip" ? ipBlacklist : uaBlacklist
      map.set(entry.value, entry)
    }
    for (const pattern of data.uaWhitelist || []) {
      if (!customUaWhitelist.includes(pattern)) {
        customUaWhitelist.push(pattern)
      }
    }
    consola.info(
      `Guard loaded: ${ipBlacklist.size} blocked IPs, ${uaBlacklist.size} blocked UAs, ${customUaWhitelist.length} custom UA patterns`,
    )
  } catch {
    // File doesn't exist yet — that's fine
  }
}

async function saveGuard(): Promise<void> {
  const data: GuardPersistence = {
    blacklist: getBlacklist(),
    uaWhitelist: [...customUaWhitelist],
  }
  await fs.writeFile(PATHS.GUARD_PATH, JSON.stringify(data, null, 2))
}
