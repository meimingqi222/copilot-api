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
  return (
    c.req.header("cf-connecting-ip")
    || c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip")
    || undefined
  )
}
