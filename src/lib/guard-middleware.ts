import type { Context, Next } from "hono"

import { isBlocked } from "~/lib/guard"

/**
 * Guard middleware — rejects requests from blacklisted IPs or User-Agents.
 * Should be placed early in the middleware chain (before auth).
 */
export async function guardMiddleware(c: Context, next: Next) {
  // Skip for admin panel so admins can always manage the blacklist
  if (c.req.path.startsWith("/admin") || c.req.path === "/health") {
    await next()
    return
  }

  const ip = extractGuardIp(c)
  const ua = c.req.header("user-agent") || undefined

  const entry = isBlocked({ ip, ua })
  if (entry) {
    const reason = entry.reason ? `: ${entry.reason}` : ""
    return c.json(
      {
        error: {
          message: `Forbidden. Your ${entry.type === "ip" ? "IP address" : "client"} has been blocked${reason}.`,
          type: "forbidden_error",
        },
      },
      403,
    )
  }

  await next()
}

function extractGuardIp(c: Context): string | undefined {
  const cfIp = c.req.header("cf-connecting-ip")
  if (cfIp && isValidIp(cfIp)) return cfIp

  const forwarded = c.req.header("x-forwarded-for")
  if (forwarded) {
    const firstIp = forwarded.split(",")[0]?.trim()
    if (isValidIp(firstIp)) return firstIp
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
