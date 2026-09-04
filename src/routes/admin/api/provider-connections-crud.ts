/**
 * Admin API: Provider Connections — CRUD 路由
 *
 * 通用 provider connection 的 create / read / update / delete。
 * 拆分自 provider-connections.ts 以满足行数限制。
 */

import { Hono } from "hono"

import {
  createConnection,
  deleteConnection,
  getProviderConnection,
  isAccountManagedConnection,
  isAccountManagedProtocol,
  isProviderProtocol,
  listProviderConnections,
  type CreateCredentialInput,
  type ModelDiscoveryConfig,
  type ModelMapping,
  sanitizeConnection,
  updateConnection,
} from "~/lib/provider-connections"
import { refreshConnectionAvailability } from "~/lib/provider-connections/availability"
import { readJsonBody } from "~/lib/request-body"
import {
  normalizeNullableArray,
  normalizeNullableObject,
} from "~/routes/admin/api/provider-connections-helpers"

export const providerConnectionCrudRoutes = new Hono()

providerConnectionCrudRoutes.get("/", (c) => {
  // 过滤 account-managed connection(*-native protocol):这些 connection
  // 由账号管理路径(/admin/api/accounts)管理,不应出现在外部 provider 列表中,
  // 避免用户在外部 provider 页面误编辑而破坏 account 路径的 metadata。
  // 判别器用 protocol 派生,T5.2.5 后仍然有效。
  //
  // 列表请求时先 refresh 一次:把已过期的 cooldown / quota_exhausted
  // 自动恢复为 ready,让 WebUI 看到实时状态(否则限额过期后仍显示红色,
  // 必须手工点"测试"才能恢复)。
  const connections = listProviderConnections().filter(
    (conn) => !isAccountManagedConnection(conn),
  )
  for (const conn of connections) {
    refreshConnectionAvailability(conn)
  }
  return c.json({
    connections: connections.map((conn) => sanitizeConnection(conn)),
  })
})

providerConnectionCrudRoutes.post("/", async (c) => {
  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON" }, 400)
  }

  const id = typeof payload.id === "string" ? payload.id : undefined
  const name = typeof payload.name === "string" ? payload.name : undefined
  const protocol =
    typeof payload.protocol === "string" ? payload.protocol : undefined
  const baseUrl =
    typeof payload.baseUrl === "string" ? payload.baseUrl : undefined

  if (!name) return c.json({ error: "`name` is required" }, 400)
  if (!protocol || !isProviderProtocol(protocol)) {
    return c.json({ error: "Invalid `protocol`" }, 400)
  }
  // 写入不变量:*-native protocol 只能由账号管理路径创建,
  // 外部 provider API 不允许创建 account-managed connection。
  if (isAccountManagedProtocol(protocol)) {
    return c.json(
      {
        error: `Protocol "${protocol}" is account-managed. Use the accounts API to create this type of connection.`,
      },
      400,
    )
  }
  if (!baseUrl) return c.json({ error: "`baseUrl` is required" }, 400)

  try {
    const connection = await createConnection({
      id,
      name,
      protocol,
      baseUrl,
      enabled: typeof payload.enabled === "boolean" ? payload.enabled : true,
      priority:
        typeof payload.priority === "number" ? payload.priority : undefined,
      weight: typeof payload.weight === "number" ? payload.weight : undefined,
      headers:
        payload.headers && typeof payload.headers === "object" ?
          (payload.headers as Record<string, string>)
        : undefined,
      modelDiscovery:
        payload.modelDiscovery && typeof payload.modelDiscovery === "object" ?
          (payload.modelDiscovery as ModelDiscoveryConfig)
        : undefined,
      models:
        Array.isArray(payload.models) ?
          (payload.models as Array<ModelMapping>)
        : undefined,
      credentials:
        Array.isArray(payload.credentials) ?
          (payload.credentials as Array<CreateCredentialInput>)
        : undefined,
    })
    return c.json({ connection: sanitizeConnection(connection) }, 201)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400)
  }
})

providerConnectionCrudRoutes.get("/:id", (c) => {
  const connection = getProviderConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Not found" }, 404)
  return c.json({ connection: sanitizeConnection(connection) })
})

providerConnectionCrudRoutes.put("/:id", async (c) => {
  const id = c.req.param("id")
  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON" }, 400)
  }

  if (
    payload.protocol !== undefined
    && (typeof payload.protocol !== "string"
      || !isProviderProtocol(payload.protocol))
  ) {
    return c.json({ error: "Invalid `protocol`" }, 400)
  }
  // 写入不变量:不允许通过外部 provider API 把 protocol 改成 *-native
  if (
    typeof payload.protocol === "string"
    && isProviderProtocol(payload.protocol)
    && isAccountManagedProtocol(payload.protocol)
  ) {
    return c.json(
      {
        error: `Protocol "${payload.protocol}" is account-managed. Use the accounts API to manage this type of connection.`,
      },
      400,
    )
  }

  try {
    const connection = await updateConnection(id, {
      name: typeof payload.name === "string" ? payload.name : undefined,
      baseUrl:
        typeof payload.baseUrl === "string" ? payload.baseUrl : undefined,
      protocol:
        (
          typeof payload.protocol === "string"
          && isProviderProtocol(payload.protocol)
        ) ?
          payload.protocol
        : undefined,
      enabled:
        typeof payload.enabled === "boolean" ? payload.enabled : undefined,
      priority:
        typeof payload.priority === "number" ? payload.priority : undefined,
      weight: typeof payload.weight === "number" ? payload.weight : undefined,
      headers: normalizeNullableObject(payload.headers) as
        | Record<string, string>
        | null
        | undefined,
      modelDiscovery: normalizeNullableObject(payload.modelDiscovery) as
        | ModelDiscoveryConfig
        | null
        | undefined,
      models: normalizeNullableArray(payload.models) as
        | Array<ModelMapping>
        | null
        | undefined,
    })
    return c.json({ connection: sanitizeConnection(connection) })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

providerConnectionCrudRoutes.delete("/:id", async (c) => {
  try {
    await deleteConnection(c.req.param("id"))
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})
