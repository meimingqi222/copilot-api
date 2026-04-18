import type { Context, Next } from "hono"

import consola from "consola"

import {
  recordRequest as recordGuardSnapshot,
  recordRequestPreview,
} from "./guard"
import { logStore } from "./log-store"
import { isProtectedRoute } from "./protected-routes"
import { statsStore } from "./stats-store"

export const requestLogger = async (c: Context, next: Next) => {
  const start = Date.now()
  await next()

  if (shouldSkipRequestLog(c.req.path)) return

  const latencyMs = Date.now() - start

  const status = c.res.status
  let level: "info" | "warn" | "error"
  if (status >= 500) {
    level = "error"
  } else if (status >= 400) {
    level = "warn"
  } else {
    level = "info"
  }

  const accountId = c.get("accountId" as never) as string | undefined
  const clientIp = extractClientIp(c)
  const userAgent = c.req.header("user-agent") || undefined

  logStore.push({
    timestamp: Date.now(),
    level,
    message: `${c.req.method} ${c.req.path} ${status}`,
    userId: c.get("userId" as never) as string | undefined,
    username: c.get("username" as never) as string | undefined,
    accountId,
    latencyMs,
    statusCode: status,
    path: c.req.path,
    clientIp,
    userAgent,
  })

  // Feed guard snapshot tracking
  const guardResult = recordGuardSnapshot({
    ip: clientIp,
    ua: userAgent,
    username: c.get("username" as never) as string | undefined,
    path: c.req.path,
    isError: shouldCountGuardError(c.req.path, status),
    initiator: c.get("guardInitiator" as never) as string | undefined,
    statusCode: status,
  })

  const shouldCapturePreview = shouldCaptureGuardPreview(
    c,
    guardResult,
    c.req.path,
  )

  if (shouldCapturePreview) {
    const requestPreview = await captureRequestPreview(c)
    if (requestPreview) {
      recordRequestPreview({
        ip: clientIp,
        ua: userAgent,
        path: c.req.path,
        statusCode: status,
        preview: requestPreview,
      })
    }
  }

  // Persist stats to SQLite for request counting
  if (accountId) {
    try {
      if (status >= 400) {
        // Atomically increment both requests and errors in a single SQL statement
        statsStore.incrementRequestAndError(accountId)
      } else {
        statsStore.incrementRequests(accountId)
      }
    } catch {
      // Stats persistence failure should not affect request flow
      consola.debug("Failed to persist stats")
    }
  }
}

function shouldSkipRequestLog(path: string): boolean {
  return (
    path === "/health"
    || path.startsWith("/admin")
    || path === "/favicon.ico"
    || path.startsWith("/static")
    || path === "/robots.txt"
    || path === "/sitemap.xml"
  )
}

function shouldCaptureGuardPreview(
  c: Context,
  guardResult: { shouldCapturePreview: boolean },
  path: string,
): boolean {
  return (
    isProtectedRoute(path)
    && (guardResult.shouldCapturePreview
      || Boolean(c.get("protectedRouteGuardCapturePreview" as never)))
  )
}

function shouldCountGuardError(path: string, status: number): boolean {
  if (status >= 500) {
    return true
  }

  if (status === 401 || status === 403 || status === 404) {
    return true
  }

  if (status === 429 && !isProtectedRoute(path)) {
    return true
  }

  return false
}

function extractClientIp(c: Context): string | undefined {
  const cfIp = c.req.header("cf-connecting-ip")
  if (cfIp && isValidIp(cfIp)) return cfIp

  const forwarded = c.req.header("x-forwarded-for")
  if (forwarded) {
    const firstIp = forwarded.split(",")[0]?.trim()
    if (firstIp && isValidIp(firstIp)) return firstIp
  }

  const realIp = c.req.header("x-real-ip")
  if (realIp && isValidIp(realIp)) return realIp

  return undefined
}

// Simple IP validation (IPv4 and IPv6)
function isValidIp(ip: string): boolean {
  if (!ip) return false
  // Basic IPv4 regex
  const ipv4Regex = /^(?:\d{1,3}\.){3}\d{1,3}$/
  // Basic IPv6 regex (simplified)
  const ipv6Regex = /^(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i
  return ipv4Regex.test(ip) || ipv6Regex.test(ip)
}

const MAX_GUARD_PREVIEW_BYTES = 16 * 1024
const MAX_GUARD_PREVIEW_CHARS = 1500
const REDACTED_VALUE = "[redacted]"
const REDACT_FIELD_RE =
  /authorization|api[-_]?key|password|token|secret|cookie|session|image|base64|data/i

async function captureRequestPreview(c: Context): Promise<string | undefined> {
  if (!["PATCH", "POST", "PUT"].includes(c.req.method)) return undefined

  const contentType = c.req.header("content-type") || ""
  if (
    !contentType.includes("application/json")
    && !contentType.startsWith("text/")
  ) {
    return undefined
  }

  const contentLength = Number(c.req.header("content-length") || 0)
  if (
    Number.isFinite(contentLength)
    && contentLength > MAX_GUARD_PREVIEW_BYTES
  ) {
    return "[body omitted: too large]"
  }

  try {
    const raw = await c.req.raw.clone().text()
    if (!raw) return undefined

    if (contentType.includes("application/json")) {
      try {
        const parsed: unknown = JSON.parse(raw)
        return truncatePreview(JSON.stringify(sanitizeJson(parsed), null, 2))
      } catch {
        return truncatePreview(raw)
      }
    }

    return truncatePreview(raw)
  } catch {
    return undefined
  }
}

function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth >= 4) return "[truncated]"

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeJson(item, depth + 1))
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .slice(0, 20)
      .map(([key, nested]) => [
        key,
        REDACT_FIELD_RE.test(key) ? REDACTED_VALUE : (
          sanitizeJson(nested, depth + 1)
        ),
      ])
    return Object.fromEntries(entries)
  }

  if (typeof value === "string") {
    return truncatePreview(value, 400)
  }

  return value
}

function truncatePreview(
  value: string,
  limit = MAX_GUARD_PREVIEW_CHARS,
): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}
