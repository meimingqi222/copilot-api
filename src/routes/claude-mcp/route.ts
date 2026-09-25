/**
 * Claude CLI 传输层的内部 MCP 回调端点。
 *
 * stdio helper（由真 `claude` 启动）把 CLI 的 `tools/call` POST 到这里，
 * 然后阻塞等结果。端点返回的是**简化形态**的结果（不是 MCP 协议本身）：
 *
 * ```jsonc
 * {"content":[{"type":"text","text":"..."}],"is_error":false}
 * ```
 *
 * 安全考虑（三层）：
 *
 * 1. 只接受**回环地址**。这个端点永远只应该被本机的 helper 访问。
 * 2. token 是一次性随机 UUID，随进程生灭，不可预测。
 * 3. 请求必须命中一个活着的 run，否则 404。
 *
 * 注意这个路由**必须注册在 `requireApiKey` 之前** —— helper 不会带 API key，
 * 而且它也不该能拿到用户的密钥。
 */

import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { getConnInfo } from "hono/bun"

import { logger } from "~/lib/logger"
import {
  ClaudeMcpCallbackError,
  handleClaudeMcpCallback,
} from "~/services/claude/cli/mcp-callback"

export const claudeMcpRoutes = new Hono()

const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
])

/** 直读 socket 地址，不看任何可伪造的代理头。 */
function remoteAddress(c: Parameters<typeof getConnInfo>[0]): string {
  try {
    return getConnInfo(c).remote.address ?? ""
  } catch {
    return ""
  }
}

claudeMcpRoutes.post("/:token", async (c) => {
  if (!LOOPBACK_ADDRESSES.has(remoteAddress(c))) {
    // 不透露端点存在。
    return c.json({ error: "not found" }, 404)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid JSON body" }, 400)
  }

  try {
    const result = await handleClaudeMcpCallback(c.req.param("token"), body)
    return c.json(result)
  } catch (error) {
    if (error instanceof ClaudeMcpCallbackError) {
      return c.json(
        { error: error.message },
        error.status as ContentfulStatusCode,
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    logger.warn("claude-cli: MCP callback failed", { error: message })
    return c.json({ error: message }, 502)
  }
})
