import { Hono } from "hono"

import { logger } from "~/lib/logger"
import {
  getProviderConnection,
  isAccountManagedConnection,
} from "~/lib/provider-connections"
import { readJsonBody } from "~/lib/request-body"
import {
  cancelWebLogin,
  getWebLoginFlow,
  publicWebLoginFlow,
  refreshWebLoginFlow,
  startWebLogin,
} from "~/services/web-login/flow"
import { isWebLoginProvider } from "~/services/web-login"

import { publicAccountFromConnection } from "./account-views"

export const webLoginApiRoutes = new Hono()

function parseLabel(body: { label?: unknown }, provider: string): string {
  const label = typeof body.label === "string" ? body.label.trim() : ""
  return label.slice(0, 120) || provider
}

function parseProxyUrl(body: { proxyUrl?: unknown }): string | undefined {
  const value = typeof body.proxyUrl === "string" ? body.proxyUrl.trim() : ""
  return value || undefined
}

/**
 * 内置网页扫码登录：服务端起临时无头浏览器出二维码，用户用手机扫，
 * 会话Cookie到位后按该 provider 自己的凭证校验兑换成账号。
 *
 * 与 `/api/oauth/:provider/*` 分开：那些是标准授权码/设备码流程，会落盘续poll；
 * 扫码登录握着浏览器句柄，只在进程内有效。
 */
webLoginApiRoutes.post("/:provider/start", async (c) => {
  const provider = c.req.param("provider")
  if (!isWebLoginProvider(provider)) {
    return c.json(
      { error: `Unsupported web sign-in provider: ${provider}` },
      400,
    )
  }

  let body: { label?: string; proxyUrl?: string }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    body = {}
  }

  try {
    const flow = await startWebLogin(provider, {
      label: parseLabel(body, provider),
      proxyUrl: parseProxyUrl(body),
    })
    return c.json({ ok: true, ...publicWebLoginFlow(flow) })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`[web-login] ${provider} 发起登录失败: ${message}`)
    return c.json({ ok: false, error: message }, 400)
  }
})

webLoginApiRoutes.get("/:provider/poll/:flowId", async (c) => {
  const provider = c.req.param("provider")
  const flowId = c.req.param("flowId")
  if (!isWebLoginProvider(provider)) {
    return c.json(
      { error: `Unsupported web sign-in provider: ${provider}` },
      400,
    )
  }
  const existing = getWebLoginFlow(flowId)
  if (!existing || existing.provider !== provider) {
    return c.json({ status: "expired", error: "登录流程不存在或已结束" }, 404)
  }

  const flow = await refreshWebLoginFlow(flowId)
  const payload = publicWebLoginFlow(flow)
  if (flow.status === "complete" && flow.accountId) {
    const connection = getProviderConnection(flow.accountId)
    if (connection && isAccountManagedConnection(connection)) {
      return c.json({
        ...payload,
        status: "complete",
        account: publicAccountFromConnection(connection),
      })
    }
  }
  if (flow.status === "error") {
    return c.json({ ...payload, ok: false }, 400)
  }
  return c.json({ ok: true, ...payload })
})

webLoginApiRoutes.post("/:provider/cancel", async (c) => {
  const provider = c.req.param("provider")
  if (!isWebLoginProvider(provider)) {
    return c.json(
      { error: `Unsupported web sign-in provider: ${provider}` },
      400,
    )
  }
  let body: { flowId?: string }
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }
  const flowId = body.flowId?.trim()
  if (!flowId) {
    return c.json({ error: "flowId is required." }, 400)
  }
  const flow = getWebLoginFlow(flowId)
  if (!flow || flow.provider !== provider) {
    return c.json({ error: `Unknown ${provider} sign-in flow.` }, 404)
  }
  await cancelWebLogin(flowId)
  return c.json({ ok: true, status: "cancelled" })
})
