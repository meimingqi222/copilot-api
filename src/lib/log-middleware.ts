import type { Context, Next } from "hono"

import { logger } from "~/lib/logger"

import {
  recordRequest as recordGuardSnapshot,
  recordRequestPreview,
} from "./guard"
import { pruneExpiredRequestLogs, readLogRotationConfig } from "./log-rotation"
import { logStore } from "./log-store"
import { isProtectedRoute } from "./protected-routes"
import {
  finalizeRequestLog,
  initRequestLog,
  isCoreApiPath,
  patchRequestLog,
  recordTraceError,
  claimRequestLogFinish,
  setRequestLogFinisher,
} from "./request-log"
import { appendRequestLogSync } from "./request-log-persist"
import { sanitizeJson } from "./security-sanitizer"
import { statsStore } from "./stats-store"
import { getClientIp } from "./utils"

export const requestLogger = async (c: Context, next: Next) => {
  const clientIp = getClientIp(c)
  const userAgent = c.req.header("user-agent") || undefined
  const isCoreApi = isCoreApiPath(c.req.path)
  const isLocalhost =
    clientIp === "127.0.0.1"
    || clientIp === "::1"
    || clientIp === "::ffff:127.0.0.1"

  const shouldSkip = !isCoreApi && shouldSkipRequestLog(c.req.path)
  const shouldSkipLocalhost = isLocalhost && !isCoreApi
  // 跳过路径(health/admin/ws/mimo 及非核心 API 的 localhost)本就不追踪:
  // 不建 ctx、不写 logStore,与旧版 `await next(); if (skip) return` 语义等价。
  if (shouldSkip || shouldSkipLocalhost) {
    await next()
    return
  }

  const ctx = initRequestLog(c)
  patchRequestLog(c, {
    clientIp,
    userAgent,
    userId: c.get("userId"),
    username: c.get("username"),
  })
  try {
    c.header("X-Request-Id", ctx.requestId)
  } catch {
    // Headers may already be committed by an upgraded or streaming response.
  }

  const persistRequestLog = () => {
    if (!claimRequestLogFinish(c)) return
    const status = c.res.status
    const finalized = finalizeRequestLog(c, status)
    const level =
      finalized.level
      ?? (status >= 500 ? "error"
      : status >= 400 ? "warn"
      : "info")
    const entry = {
      ...finalized,
      timestamp: finalized.timestamp ?? Date.now(),
      level,
      message: finalized.message ?? `${c.req.method} ${c.req.path} ${status}`,
      userId: finalized.userId ?? c.get("userId"),
      username: finalized.username ?? c.get("username"),
      accountId: finalized.accountId ?? c.get("accountId"),
      statusCode: status,
      path: finalized.path ?? c.req.path,
      clientIp: finalized.clientIp ?? clientIp,
      userAgent: finalized.userAgent ?? userAgent,
      method: finalized.method ?? c.req.method,
      apiKind: finalized.apiKind,
      provider: finalized.provider ?? (c.get("provider") as string | undefined),
      connectionId:
        finalized.connectionId ?? (c.get("connectionId") as string | undefined),
      credentialId:
        finalized.credentialId ?? (c.get("credentialId") as string | undefined),
      initiator: finalized.initiator ?? c.get("guardInitiator"),
    }
    logStore.push(entry)
    appendRequestLogSync(entry)
  }
  setRequestLogFinisher(c, persistRequestLog)

  let nextError: unknown
  try {
    await next()
  } catch (error) {
    nextError = error
    recordTraceError(c, error)
    throw error
  } finally {
    const status = nextError ? 500 : c.res.status
    const accountId = c.get("accountId")
    // Hono returns the SSE Response before its producer has consumed the
    // upstream stream. The producer explicitly finishes these requests after
    // observing the protocol terminal; non-stream requests finish here.
    if (!ctx.entry.streaming || nextError) persistRequestLog()
    try {
      const cfg = readLogRotationConfig()
      maybePruneRequestLogs(cfg, new Date())
    } catch {
      // Request logging cleanup is best-effort and must not affect the response.
    }

    const guardResult =
      !isLocalhost ?
        recordGuardSnapshot({
          ip: clientIp,
          ua: userAgent,
          username: c.get("username"),
          path: c.req.path,
          isError: shouldCountGuardError(c.req.path, status),
          initiator: c.get("guardInitiator"),
          statusCode: status,
        })
      : undefined

    if (guardResult) {
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
    }

    if (accountId) {
      queueMicrotask(() => {
        try {
          if (status >= 400) statsStore.incrementRequestAndError(accountId)
          else statsStore.incrementRequests(accountId)
        } catch {
          logger.debug("Failed to persist stats")
        }
      })
    }
  }
}

let lastRequestLogPruneAt = 0
function maybePruneRequestLogs(
  config: ReturnType<typeof readLogRotationConfig>,
  now: Date,
): void {
  if (now.getTime() - lastRequestLogPruneAt < 60 * 60 * 1000) return
  lastRequestLogPruneAt = now.getTime()
  pruneExpiredRequestLogs(config, now)
}

function shouldSkipRequestLog(path: string): boolean {
  return (
    path === "/health"
    || path === "/ws/mimo"
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
