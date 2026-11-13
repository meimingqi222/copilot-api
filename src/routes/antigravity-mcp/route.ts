/**
 * Antigravity ACP 传输层的内部 MCP 回调端点。
 *
 * 仅接受回环地址，通过一次性 run token 路由到挂起中的 `AgyRun`。
 * 必须注册在 `requireApiKey` 之前。
 */

import { Hono } from "hono"
import { getConnInfo } from "hono/bun"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import { logger } from "~/lib/logger"
import {
  AntigravityMcpCallbackError,
  handleAntigravityMcpCallback,
} from "~/services/antigravity/acp/mcp-callback"

export const antigravityMcpRoutes = new Hono()

const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
])

function remoteAddress(c: Parameters<typeof getConnInfo>[0]): string {
  try {
    return getConnInfo(c).remote.address ?? ""
  } catch {
    return ""
  }
}

antigravityMcpRoutes.post("/:token", async (c) => {
  if (!LOOPBACK_ADDRESSES.has(remoteAddress(c))) {
    return c.json({ error: "not found" }, 404)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid JSON body" }, 400)
  }

  try {
    const result = await handleAntigravityMcpCallback(
      c.req.param("token"),
      body,
    )
    return c.json(result)
  } catch (error) {
    if (error instanceof AntigravityMcpCallbackError) {
      return c.json(
        { error: error.message },
        error.status as ContentfulStatusCode,
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    logger.warn("antigravity-acp: MCP callback failed", { error: message })
    return c.json({ error: message }, 502)
  }
})
