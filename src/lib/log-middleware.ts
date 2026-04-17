import type { Context, Next } from "hono"

import consola from "consola"

import { recordRequest as recordGuardSnapshot } from "./guard"
import { logStore } from "./log-store"
import { statsStore } from "./stats-store"

export const requestLogger = async (c: Context, next: Next) => {
  const start = Date.now()
  await next()

  // Skip logging for admin panel, health check, and static resources
  if (c.req.path.startsWith("/admin") || c.req.path === "/health") return
  if (c.req.path === "/favicon.ico" || c.req.path.startsWith("/static")) return
  if (c.req.path === "/robots.txt" || c.req.path === "/sitemap.xml") return

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
  recordGuardSnapshot({
    ip: clientIp,
    ua: userAgent,
    username: c.get("username" as never) as string | undefined,
    path: c.req.path,
    isError: status >= 400,
    initiator: c.req.header("x-initiator") || undefined,
  })

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
