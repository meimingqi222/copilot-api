/**
 * Admin API: 即时模型探测 (fetch-models)
 *
 * 接收临时配置，不落盘、不建连接，直接探测上游可用模型。
 */

import type { Context } from "hono"

import {
  isAccountManagedProtocol,
  isProviderProtocol,
  type ApiCredential,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { readJsonBody } from "~/lib/request-body"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

export async function handleFetchModels(c: Context): Promise<Response> {
  initializeProtocolAdapters()

  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON" }, 400)
  }

  const protocol =
    typeof payload.protocol === "string" ? payload.protocol : undefined
  const baseUrl =
    typeof payload.baseUrl === "string" ? payload.baseUrl : undefined
  const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : undefined

  if (!protocol || !isProviderProtocol(protocol)) {
    return c.json({ error: "Invalid `protocol`" }, 400)
  }
  if (isAccountManagedProtocol(protocol)) {
    return c.json(
      { error: "Account-managed protocols are not supported here" },
      400,
    )
  }
  if (!baseUrl) return c.json({ error: "`baseUrl` is required" }, 400)

  // SSRF 防护: 只允许 http/https 协议
  try {
    const parsed = new URL(baseUrl)
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return c.json({ error: "Only http/https baseUrl is allowed" }, 400)
    }
  } catch {
    return c.json({ error: "Invalid `baseUrl`" }, 400)
  }

  const adapter = getProtocolAdapter(protocol)
  if (!adapter?.discoverModels) {
    return c.json(
      { error: `Protocol "${protocol}" does not support model discovery` },
      400,
    )
  }

  const authMode =
    typeof payload.authMode === "string" && payload.authMode === "header" ?
      "header"
    : "bearer"
  const headerName =
    typeof payload.headerName === "string" ? payload.headerName : "x-api-key"
  // 免费车道(Kilo 公共网关这类匿名上游):只保留上游标记 isFree 的模型,
  // 否则探测结果里全是匿名请求必 401 的付费 id。
  const freeOnly = payload.freeOnly === true

  // 构造临时 connection 和 credential 对象 (不落盘)
  const tempConnection: ProviderConnection = {
    id: "__fetch_models_temp__",
    name: "__fetch_models_temp__",
    protocol,
    baseUrl,
    enabled: true,
    priority: 0,
    // 探测走与落库后同一套固定请求头：供应商要求客户端身份头时（Kimi
    // Coding 的 /coding 端点），不带头部探测会被 403，而保存后的真实
    // 请求带头部却能通。
    headers:
      payload.headers && typeof payload.headers === "object" ?
        (payload.headers as Record<string, string>)
      : undefined,
    // 探测走与落库后同一个代理：否则新建表单里“在线获取模型”能通、
    // 保存后的真实请求却不通（或反之）。
    proxyUrl:
      typeof payload.proxyUrl === "string" && payload.proxyUrl.trim() ?
        payload.proxyUrl.trim()
      : undefined,
    credentials: [],
    createdAt: Date.now(),
    modelDiscovery: {
      enabled: true,
      mode: "manual-only",
      endpoint:
        typeof payload.discoveryEndpoint === "string" ?
          payload.discoveryEndpoint
        : undefined,
      freeOnly,
    },
  }
  const tempCredential: ApiCredential = {
    id: "__fetch_models_temp__",
    authMode,
    headerName: authMode === "header" ? headerName : undefined,
    value: apiKey || "",
    enabled: true,
    status: "ready",
    createdAt: Date.now(),
  }

  // 10 秒超时
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const models = await adapter.discoverModels({
      connection: tempConnection,
      credential: tempCredential,
      signal: controller.signal,
    })
    return c.json({
      models: models.map((m) => ({
        publicId: m.publicId,
        upstreamId: m.upstreamId,
        vendor: m.vendor,
        endpoints: m.endpoints,
      })),
    })
  } catch (error) {
    const message = (error as Error).message
    let hint: string | undefined
    const status = (error as { response?: { status: number } }).response?.status
    const bodyText =
      typeof (error as { responseBody?: unknown }).responseBody === "string" ?
        (error as { responseBody: string }).responseBody
      : ""

    if (
      status === 401
      || status === 403
      || message.includes("401")
      || message.includes("403")
      || bodyText.includes("401")
      || bodyText.includes("403")
    ) {
      hint = "API Key 无效或权限不足"
    } else if (
      message.includes("abort")
      || message.includes("timeout")
      || message.includes("aborted")
    ) {
      hint = "上游无响应，请检查 Base URL 是否正确"
    } else if (
      message.includes("fetch failed")
      || message.includes("ECONNREFUSED")
    ) {
      hint = "无法连接到上游，请检查 Base URL 和网络"
    }
    return c.json({ error: message, hint }, 502)
  } finally {
    clearTimeout(timeout)
  }
}
