/**
 * Admin API: 账号模型管理。
 *
 * account-managed connection 的模型清单由 provider 刷新全权管理,
 * 但用户层的改名/开关/别名经 mergeProviderRefreshedModels 持久保留,
 * 因此这里只开放用户层配置:
 * - GET /:id/models:模型清单(含 enabled/aliases,供管理抽屉)
 * - PUT /:id/models/:publicId:改名(publicId)/开关(enabled)/别名(aliases)
 *
 * 显示名(name)/upstreamId/endpoints 由 provider 刷新决定,改了也会被
 * 覆盖回去 → 409;增删模型刷新即恢复/覆盖 → 不提供对应接口。
 */

import { Hono } from "hono"

import {
  getMutableProviderConnection,
  isAccountManagedConnection,
  ModelConflictError,
  normalizeModelAliases,
  updateModel,
} from "~/lib/provider-connections"
import { readJsonBody } from "~/lib/request-body"

export const accountModelRoutes = new Hono()

function getAccountConnection(
  id: string,
): ReturnType<typeof getMutableProviderConnection> {
  const conn = getMutableProviderConnection(id)
  return conn && isAccountManagedConnection(conn) ? conn : undefined
}

accountModelRoutes.get("/:id/models", (c) => {
  const conn = getAccountConnection(c.req.param("id"))
  if (!conn) return c.json({ error: "Account not found." }, 404)
  return c.json({ models: conn.models ?? [] })
})

accountModelRoutes.put("/:id/models/:publicId", async (c) => {
  const conn = getAccountConnection(c.req.param("id"))
  if (!conn) return c.json({ error: "Account not found." }, 404)

  const publicId = decodeURIComponent(c.req.param("publicId"))

  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  // 显示名(name)/upstreamId/endpoints 由 provider 刷新决定,改了也会被覆盖回去。
  if (
    (typeof payload.name === "string" && payload.name)
    || (typeof payload.upstreamId === "string" && payload.upstreamId)
    || (Array.isArray(payload.endpoints) && payload.endpoints.length > 0)
  ) {
    return c.json(
      {
        error:
          "Account-managed name/upstreamId/endpoints are provider-driven and cannot be changed.",
      },
      409,
    )
  }

  const patch: Parameters<typeof updateModel>[2] = {}
  if (typeof payload.publicId === "string" && payload.publicId)
    patch.publicId = payload.publicId.trim()
  if (typeof payload.enabled === "boolean") patch.enabled = payload.enabled
  const aliases = normalizeModelAliases(payload.aliases)
  if (aliases !== undefined) patch.aliases = aliases

  try {
    const model = await updateModel(conn.id, publicId, patch)
    return c.json({ model })
  } catch (error) {
    if (error instanceof ModelConflictError) {
      return c.json({ error: (error as Error).message }, 409)
    }
    return c.json({ error: (error as Error).message }, 404)
  }
})
