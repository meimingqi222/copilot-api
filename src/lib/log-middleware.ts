import type { Context, Next } from "hono"

import { logger } from "~/lib/logger"

import {
  isBlocked,
  recordRequest as recordGuardSnapshot,
  recordRequestPreview,
} from "./guard"
import { pruneExpiredRequestLogs, readLogRotationConfig } from "./log-rotation"
import { logStore } from "./log-store"
import {
  reportRequestError,
  reportRequestSuccess,
  reportUpstream429,
} from "./protected-route-guard"
import { isProtectedRoute } from "./protected-routes"
import { dumpIncomingRequest } from "./request-dump"
import {
  finalizeRequestLog,
  finalizeUpstreamModelAudit,
  getRequestLogContext,
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

  // Body 必须在 handler 消费之前 clone 读取,否则拿不到内容。
  // 被拉黑的请求不写 dump：guardMiddleware 在下游返回 403，这里预检一次
  //（与拦截用同一函数、同一输入，结果一致），否则黑名单 IP 的原始 body
  // 会在 DUMP_REQUESTS=1 时持续落盘。
  const preBlocked =
    !isLocalhost && isBlocked({ ip: clientIp, ua: userAgent }) !== null
  if (!preBlocked) {
    await dumpIncomingRequest(c, { requestId: ctx.requestId, clientIp })
  }

  // nextError 提前声明：persistRequestLog 在流式 deferred 落盘时也需要它
  // 来判断 500（此时 c.res.status 还没反映抛错）。
  let nextError: unknown
  const persistRequestLog = () => {
    if (!claimRequestLogFinish(c)) return
    // daily_stats 与 request log 同一次落盘、恰好一次：
    // 流式请求的 accountId 在 SSE producer 里 dispatch 后才落定，
    // middleware finally 时还拿不到，放这里才能计入流式。
    // 非流式行为不变（finally 里同步调用，status/accountId 与原来一致）。
    queueMicrotask(() => {
      try {
        const accountId = c.get("accountId")
        if (!accountId) return
        const status = nextError ? 500 : c.res.status
        if (status >= 400) statsStore.incrementRequestAndError(accountId)
        else statsStore.incrementRequests(accountId)
      } catch {
        logger.debug("Failed to persist stats")
      }
    })
    // 被安全防护拉黑的请求不再写入系统日志（guard 快照仍会更新，
    // 以便在安全防护页看到最后活跃时间）。
    try {
      if (c.get("guardRejected")) return
    } catch {
      // Context 已结束时按正常路径继续
    }
    const status = c.res.status
    // 上游自报模型审计：必须在 finalizeRequestLog 之前结算，否则这一条日志
    // 就少了 modelResponse/modelMismatch。只观测不改行为，流式路径在
    // producer 收尾后也会走到这里。
    const modelVerdict = finalizeUpstreamModelAudit(c)
    const finalized = finalizeRequestLog(c, status)
    const level =
      finalized.level
      ?? (status >= 500 ? "error"
      : status >= 400 ? "warn"
      : "info")
    // 上游静默换模型是请求成功但结果可疑的情况：抬到 warn，否则会被淹没在
    // 一片 info 里。仅在 HTTP 成功时抬升，失败请求已经有自己的 error/warn。
    const modelMismatchWarning = modelVerdict === "mismatch" && status < 400
    const entry = {
      ...finalized,
      timestamp: finalized.timestamp ?? Date.now(),
      level: modelMismatchWarning ? "warn" : level,
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
    if (modelMismatchWarning) {
      logger.warn(
        `[upstream-model-audit] response model mismatch: sent "${entry.modelUpstream ?? entry.model ?? "-"}" but upstream reported "${entry.modelResponse}"`,
        {
          requestId: entry.requestId,
          endpoint: entry.endpoint,
          connectionId: entry.connectionId,
          credentialId: entry.credentialId,
          model: entry.model,
          modelUpstream: entry.modelUpstream,
          modelResponse: entry.modelResponse,
        },
      )
    }
  }
  setRequestLogFinisher(c, persistRequestLog)

  try {
    await next()
  } catch (error) {
    nextError = error
    recordTraceError(c, error)
    throw error
  } finally {
    const status = nextError ? 500 : c.res.status
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

    reportGuardOutcome(c, status)
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

// Feed the per-principal behavior guard from the final response status.
// Guard-generated rejections are excluded to avoid a block → error →
// longer-block feedback loop. Only 401/403 count as failures (400/404 are
// user confusion, 5xx is our fault); copilot upstream 429s feed the
// upstream signal unless the log shows a quota/billing cause.
function reportGuardOutcome(c: Context, status: number): void {
  try {
    if (c.get("guardRejected")) return
    if (!c.get("protectedRouteGuardPrincipal")) return
  } catch {
    return
  }
  try {
    if (status >= 200 && status < 300) {
      reportRequestSuccess(c)
      return
    }
    if (status === 401 || status === 403) {
      reportRequestError(c, status)
      return
    }
    if (status === 429) {
      reportCopilotUpstream429(c)
    }
  } catch {
    // Guard reporting must never break the request path.
  }
}

function reportCopilotUpstream429(c: Context): void {
  if (!isCopilotProvider(c)) return
  if (hasQuotaCause(c)) return
  reportUpstream429(c, "copilot")
}

function isCopilotProvider(c: Context): boolean {
  try {
    const provider = c.get("provider")
    return typeof provider === "string" && provider.includes("copilot")
  } catch {
    return false
  }
}

function hasQuotaCause(c: Context): boolean {
  try {
    const entry = getRequestLogContext(c)?.entry as
      | { error?: unknown }
      | undefined
    const errText =
      typeof entry?.error === "string" ? entry.error.toLowerCase() : ""
    return /quota|rate_limit|rate limit|exhausted|billing/.test(errText)
  } catch {
    return false
  }
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
