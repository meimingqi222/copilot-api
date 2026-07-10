import { addBlacklistEntry } from "~/lib/guard"
import { logger } from "~/lib/logger"

interface LoginAttemptState {
  failedAttempts: number
  firstFailedAt: number
  lockedUntil: number
  lastAttemptAt: number
}

const MAX_ATTEMPTS_BEFORE_LOCK = 5
const LOCK_DURATION_MS = 15 * 60 * 1000
const LOCK_DURATION_SEVERE_MS = 60 * 60 * 1000
const LOCK_DURATION_CRITICAL_MS = 24 * 60 * 60 * 1000
const SEVERE_THRESHOLD = 10
const CRITICAL_THRESHOLD = 15
const MIN_INTERVAL_MS = 1000
const MIN_INTERVAL_AFTER_FAILURES = 3
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const ENTRY_TTL_MS = 60 * 60 * 1000

const attempts = new Map<string, LoginAttemptState>()
let cleanupTimer: ReturnType<typeof setInterval> | undefined

function ensureCleanup(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of attempts) {
      if (entry.lockedUntil < now && entry.lastAttemptAt + ENTRY_TTL_MS < now) {
        attempts.delete(ip)
      }
    }
  }, CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()
}

function isLocalhost(ip: string): boolean {
  return (
    ip === "127.0.0.1"
    || ip === "::1"
    || ip === "::ffff:127.0.0.1"
    || ip === "localhost"
  )
}

export interface LoginProtectionResult {
  allowed: boolean
  retryAfterSeconds?: number
  reason?: string
}

export function checkLoginAllowed(ip: string): LoginProtectionResult {
  if (isLocalhost(ip)) return { allowed: true }

  ensureCleanup()
  const entry = attempts.get(ip)
  if (!entry) return { allowed: true }

  const now = Date.now()

  // Lockout check (5+ failures escalates to 15m/1h/24h)
  if (entry.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((entry.lockedUntil - now) / 1000)
    return {
      allowed: false,
      retryAfterSeconds,
      reason: `Too many failed login attempts. Try again in ${retryAfterSeconds} seconds.`,
    }
  }

  // Minimum interval check: after 3+ failures, enforce 1s gap between attempts
  if (entry.failedAttempts >= MIN_INTERVAL_AFTER_FAILURES) {
    const elapsed = now - entry.lastAttemptAt
    if (elapsed < MIN_INTERVAL_MS) {
      const waitMs = MIN_INTERVAL_MS - elapsed
      const retryAfterSeconds = Math.ceil(waitMs / 1000)
      return {
        allowed: false,
        retryAfterSeconds,
        reason: `Too many attempts. Please wait ${retryAfterSeconds} second(s) before trying again.`,
      }
    }
  }

  return { allowed: true }
}

export function recordLoginSuccess(ip: string): void {
  if (isLocalhost(ip)) return
  attempts.delete(ip)
}

export async function recordLoginFailure(
  ip: string,
): Promise<LoginProtectionResult> {
  if (isLocalhost(ip)) return { allowed: true }

  ensureCleanup()
  const now = Date.now()

  let entry = attempts.get(ip)
  if (!entry) {
    entry = {
      failedAttempts: 0,
      firstFailedAt: now,
      lockedUntil: 0,
      lastAttemptAt: 0,
    }
    attempts.set(ip, entry)
  }

  entry.failedAttempts += 1
  entry.lastAttemptAt = now

  if (entry.failedAttempts >= CRITICAL_THRESHOLD) {
    entry.lockedUntil = now + LOCK_DURATION_CRITICAL_MS
    logger.warn(
      `Login brute-force protection: IP ${ip} locked for 24h after ${entry.failedAttempts} failed attempts`,
    )
    await addBlacklistEntry({
      value: ip,
      type: "ip",
      source: "auto",
      reason: `Auto-blocked: login brute-force (${entry.failedAttempts} failed attempts)`,
      expiresAt: now + LOCK_DURATION_CRITICAL_MS,
      triggerScore: 100,
      triggerReasons: ["login_brute_force"],
    }).catch(() => {})
    const retryAfterSeconds = Math.ceil(LOCK_DURATION_CRITICAL_MS / 1000)
    return {
      allowed: false,
      retryAfterSeconds,
      reason: `Too many failed login attempts. IP blocked for 24 hours.`,
    }
  }

  if (entry.failedAttempts >= SEVERE_THRESHOLD) {
    entry.lockedUntil = now + LOCK_DURATION_SEVERE_MS
    logger.warn(
      `Login brute-force protection: IP ${ip} locked for 1h after ${entry.failedAttempts} failed attempts`,
    )
    const retryAfterSeconds = Math.ceil(LOCK_DURATION_SEVERE_MS / 1000)
    return {
      allowed: false,
      retryAfterSeconds,
      reason: `Too many failed login attempts. Try again in ${retryAfterSeconds} seconds.`,
    }
  }

  if (entry.failedAttempts >= MAX_ATTEMPTS_BEFORE_LOCK) {
    entry.lockedUntil = now + LOCK_DURATION_MS
    logger.warn(
      `Login brute-force protection: IP ${ip} locked for 15m after ${entry.failedAttempts} failed attempts`,
    )
    const retryAfterSeconds = Math.ceil(LOCK_DURATION_MS / 1000)
    return {
      allowed: false,
      retryAfterSeconds,
      reason: `Too many failed login attempts. Try again in ${retryAfterSeconds} seconds.`,
    }
  }

  const remaining = MAX_ATTEMPTS_BEFORE_LOCK - entry.failedAttempts
  return {
    allowed: true,
    reason:
      remaining > 0 ?
        `${remaining} attempts remaining before lockout`
      : undefined,
  }
}

export function getLoginProtectionState(
  ip: string,
): LoginAttemptState | undefined {
  return attempts.get(ip)
}

export function resetLoginProtectionForTest(): void {
  attempts.clear()
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = undefined
  }
}
