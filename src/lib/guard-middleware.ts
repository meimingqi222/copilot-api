import type { Context, Next } from "hono"

import { isBlocked } from "~/lib/guard"
import { getClientIp } from "~/lib/utils"

/**
 * Guard middleware — rejects requests from blacklisted IPs or User-Agents.
 * Should be placed early in the middleware chain (before auth).
 */
export async function guardMiddleware(c: Context, next: Next) {
  // Skip for admin panel so admins can always manage the blacklist.
  // MiMo bridge WebSocket has its own high-entropy token check and can reconnect
  // aggressively, so do not let global IP/UA blacklist state affect it.
  if (
    c.req.path.startsWith("/admin")
    || c.req.path === "/health"
    || c.req.path === "/ws/mimo"
  ) {
    await next()
    return
  }

  const ip = getClientIp(c)
  const ua = c.req.header("user-agent") || undefined

  // Skip guard for localhost requests
  if (!ip || ip === "127.0.0.1" || ip === "::1") {
    await next()
    return
  }

  const entry = isBlocked({ ip, ua })
  if (entry) {
    const reason = entry.reason ? `: ${entry.reason}` : ""
    // 标记给 requestLogger：被拉黑的请求不再写入系统日志
    //（避免黑名单 IP 持续刷屏），但 guard 快照仍会更新。
    try {
      c.set("guardRejected" as never, true)
    } catch {
      // Context 已结束时忽略
    }
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
