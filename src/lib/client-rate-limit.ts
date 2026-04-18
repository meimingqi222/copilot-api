import type { Context, Next } from "hono"

import consola from "consola"

import { isProtectedRoute } from "~/lib/protected-routes"

/**
 * Per-key client-side rate limiter.
 *
 * Limits how many requests a single API key (or IP if unauthenticated)
 * can make within a sliding window. This prevents a leaked key from being
 * used to drain upstream quota at high frequency.
 *
 * Also detects suspicious patterns (e.g. rapid-fire requests) and logs
 * warnings for investigation.
 */

interface ClientBucket {
  /** Request timestamps within the current window */
  timestamps: Array<number>
  /** Total requests tracked for alerting */
  totalRequests: number
  /** Whether we already emitted a warning for this bucket in this window */
  warned: boolean
}

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 30
const ALERT_THRESHOLD = 20
const CLEANUP_INTERVAL_MS = 5 * 60_000

const buckets = new Map<string, ClientBucket>()

let cleanupTimer: ReturnType<typeof setInterval> | undefined

function ensureCleanup() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      // Remove buckets with no activity in the last window
      const lastTs = bucket.timestamps.at(-1)
      if (
        bucket.timestamps.length === 0
        || (lastTs !== undefined && lastTs < now - DEFAULT_WINDOW_MS)
      ) {
        buckets.delete(key)
      }
    }
  }, CLEANUP_INTERVAL_MS)
  // Allow process to exit even if timer is active
  if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref()
  }
}

function getClientIpFromRequest(c: Context): string {
  return (
    c.req.header("cf-connecting-ip")
    || c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip")
    || "unknown"
  )
}

function getBucketKey(c: Context): string {
  // Prefer user ID (multi-user mode), then raw bearer token hash, then IP
  const userId = c.get("userId" as never) as string | undefined
  if (userId) return `user:${userId}`

  const authHeader = c.req.header("authorization")
  if (authHeader) {
    // Use first 16 chars of the token as bucket key (enough to distinguish)
    const token = authHeader.split(" ")[1] ?? ""
    return `key:${token.slice(0, 16)}`
  }

  return `ip:${getClientIpFromRequest(c)}`
}

function slideWindow(bucket: ClientBucket, windowStart: number): void {
  while (bucket.timestamps.length > 0 && bucket.timestamps[0] < windowStart) {
    bucket.timestamps.shift()
  }
  if (bucket.timestamps.length === 0) {
    bucket.warned = false
  }
}

function emitSuspiciousWarning(
  c: Context,
  bucket: ClientBucket,
  opts: { bucketKey: string; windowMs: number },
): void {
  if (bucket.timestamps.length < ALERT_THRESHOLD || bucket.warned) return
  bucket.warned = true
  const ip = getClientIpFromRequest(c)
  const ua = c.req.header("user-agent") || "unknown"
  consola.warn(
    `\u26A0 Suspicious activity: ${opts.bucketKey} made ${bucket.timestamps.length} requests in ${opts.windowMs / 1000}s (IP: ${ip}, UA: ${ua})`,
  )
}

export function clientRateLimit(options?: {
  windowMs?: number
  maxRequests?: number
}) {
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS
  const maxRequests = options?.maxRequests ?? DEFAULT_MAX_REQUESTS_PER_WINDOW

  ensureCleanup()

  return async (c: Context, next: Next) => {
    // Skip rate limiting for admin dashboard and health check
    if (c.req.path === "/health" || c.req.path.startsWith("/admin")) {
      await next()
      return
    }

    if (!isProtectedRoute(c.req.path)) {
      await next()
      return
    }

    const bucketKey = getBucketKey(c)
    const now = Date.now()

    let bucket = buckets.get(bucketKey)
    if (!bucket) {
      bucket = { timestamps: [], totalRequests: 0, warned: false }
      buckets.set(bucketKey, bucket)
    }

    slideWindow(bucket, now - windowMs)

    if (bucket.timestamps.length >= maxRequests) {
      const retryAfterSec = Math.ceil(
        ((bucket.timestamps[0] ?? now) + windowMs - now) / 1000,
      )
      consola.warn(
        `Client rate limited: ${bucketKey} \u2014 ${bucket.timestamps.length} requests in ${windowMs / 1000}s window (limit: ${maxRequests})`,
      )
      return c.json(
        {
          error: {
            message: `Rate limit exceeded. Maximum ${maxRequests} requests per ${windowMs / 1000} seconds. Retry after ${retryAfterSec}s.`,
            type: "rate_limit_error",
          },
        },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      )
    }

    bucket.timestamps.push(now)
    bucket.totalRequests += 1
    emitSuspiciousWarning(c, bucket, { bucketKey, windowMs })

    await next()
  }
}

/**
 * Reset all client rate limit state (for testing)
 */
export function resetClientRateLimitForTest() {
  buckets.clear()
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = undefined
  }
}
