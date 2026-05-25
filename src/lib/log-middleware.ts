import type { Context, Next } from "hono"

import consola from "consola"

import {
  recordRequest as recordGuardSnapshot,
  recordRequestPreview,
} from "./guard"
import { logStore } from "./log-store"
import { isProtectedRoute } from "./protected-routes"
import { statsStore } from "./stats-store"
import { getClientIp } from "./utils"

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

  const accountId = c.get("accountId")
  const clientIp = getClientIp(c)
  const userAgent = c.req.header("user-agent") || undefined

  logStore.push({
    timestamp: Date.now(),
    level,
    message: `${c.req.method} ${c.req.path} ${status}`,
    userId: c.get("userId"),
    username: c.get("username"),
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
    username: c.get("username"),
    path: c.req.path,
    isError: shouldCountGuardError(c.req.path, status),
    initiator: c.get("guardInitiator"),
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
      || Boolean(c.get("protectedRouteGuardCapturePreview")))
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

const MAX_GUARD_PREVIEW_BYTES = 256 * 1024
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
    if (Buffer.byteLength(raw, "utf8") > MAX_GUARD_PREVIEW_BYTES) {
      return "[body omitted: too large]"
    }

    if (contentType.includes("application/json")) {
      try {
        const parsed: unknown = JSON.parse(raw)
        return JSON.stringify(sanitizeJson(parsed), null, 2)
      } catch {
        return raw
      }
    }

    return raw
  } catch {
    return undefined
  }
}

function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJson(item))
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, nested]) => [
      key,
      REDACT_FIELD_RE.test(key) ? REDACTED_VALUE : sanitizeJson(nested),
    ])
    return Object.fromEntries(entries)
  }

  return value
}
