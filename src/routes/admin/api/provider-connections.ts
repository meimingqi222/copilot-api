/**
 * Admin API: Provider Connections
 *
 * 通用 provider connection 的 CRUD 与 credential 子资源管理。
 * 与 legacy `accounts` API 并存,不互相干扰。
 */

import { Hono } from "hono"

import { logger } from "~/lib/logger"
import {
  addCredential,
  addModel,
  applyDiscoveredModels,
  createConnection,
  deleteConnection,
  deleteCredential,
  deleteModel,
  findCredential,
  getProviderConnection,
  isCredentialAuthMode,
  isModelEndpoint,
  isProviderProtocol,
  listProviderConnections,
  type ModelEndpoint,
  persistProviderConnections,
  resetCredentialStatus,
  sanitizeConnection,
  sanitizeCredential,
  setCredentialEnabled,
  setDiscoveryError,
  updateConnection,
  updateCredential,
  updateModel,
} from "~/lib/provider-connections"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

export const providerConnectionApiRoutes = new Hono()

function normalizeNullableObject(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === null) return null
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function normalizeNullableArray(
  value: unknown,
): Array<unknown> | null | undefined {
  if (value === null) return null
  if (Array.isArray(value)) return value as Array<unknown>
  return undefined
}

providerConnectionApiRoutes.get("/", (c) => {
  return c.json({
    connections: listProviderConnections().map((conn) =>
      sanitizeConnection(conn),
    ),
  })
})

providerConnectionApiRoutes.post("/", async (c) => {
  let payload: Record<string, unknown>
  try {
    payload = await c.req.json()
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
          (payload.modelDiscovery as never)
        : undefined,
      models:
        Array.isArray(payload.models) ? (payload.models as never) : undefined,
      credentials:
        Array.isArray(payload.credentials) ?
          (payload.credentials as never)
        : undefined,
    })
    return c.json({ connection: sanitizeConnection(connection) }, 201)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400)
  }
})

providerConnectionApiRoutes.get("/:id", (c) => {
  const connection = getProviderConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Not found" }, 404)
  return c.json({ connection: sanitizeConnection(connection) })
})

providerConnectionApiRoutes.put("/:id", async (c) => {
  const id = c.req.param("id")
  let payload: Record<string, unknown>
  try {
    payload = await c.req.json()
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
      modelDiscovery: normalizeNullableObject(payload.modelDiscovery) as never,
      models: normalizeNullableArray(payload.models) as never,
    })
    return c.json({ connection: sanitizeConnection(connection) })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

providerConnectionApiRoutes.delete("/:id", async (c) => {
  try {
    await deleteConnection(c.req.param("id"))
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

// 触发自动模型发现
providerConnectionApiRoutes.post("/:id/refresh-models", async (c) => {
  initializeProtocolAdapters()
  const id = c.req.param("id")
  const connection = getProviderConnection(id)
  if (!connection) return c.json({ error: "Not found" }, 404)
  const adapter = getProtocolAdapter(connection.protocol)
  if (!adapter?.discoverModels) {
    return c.json(
      { error: `Protocol "${connection.protocol}" does not support discovery` },
      400,
    )
  }
  const usable = connection.credentials.find((cred) => cred.enabled)
  if (!usable) {
    return c.json({ error: "No enabled credentials" }, 400)
  }

  try {
    const discovered = await adapter.discoverModels({
      connection,
      credential: usable,
    })
    const mode = connection.modelDiscovery?.mode ?? "merge"
    await applyDiscoveredModels(id, discovered, mode)
    const updated = getProviderConnection(id)
    if (!updated) return c.json({ error: "Not found" }, 404)
    return c.json({
      connection: sanitizeConnection(updated),
      discovered: discovered.length,
    })
  } catch (error) {
    await setDiscoveryError(id, (error as Error).message).catch(
      (err: unknown) => {
        logger.debug(`Failed to set discovery error: ${(err as Error).message}`)
      },
    )
    return c.json({ error: (error as Error).message }, 502)
  }
})

// 测试 API 连通性
providerConnectionApiRoutes.post("/:id/test", async (c) => {
  initializeProtocolAdapters()
  const connection = getProviderConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Not found" }, 404)

  const body = (await c.req
    .json()
    .catch(() => ({}) as Record<string, unknown>)) as Record<string, unknown>
  const credentialId =
    typeof body.credentialId === "string" ? body.credentialId : undefined
  const credential =
    credentialId ?
      connection.credentials.find((cr) => cr.id === credentialId)
    : connection.credentials.find((cr) => cr.enabled)
  if (!credential)
    return c.json({ ok: false, error: "No enabled credentials" }, 400)

  const adapter = getProtocolAdapter(connection.protocol)
  const start = Date.now()

  try {
    if (adapter?.discoverModels) {
      await adapter.discoverModels({ connection, credential })
      return c.json({
        ok: true,
        latencyMs: Date.now() - start,
        method: "model-list",
      })
    }
    // fallback: plain HTTP probe
    const testUrl = `${connection.baseUrl}/models`
    const headers: Record<string, string> = {}
    if (credential.authMode === "header") {
      headers[credential.headerName ?? "Authorization"] = credential.value
    } else {
      headers["Authorization"] = `Bearer ${credential.value}`
    }
    const res = await fetch(testUrl, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    return c.json({
      ok: res.ok,
      status: res.status,
      latencyMs: Date.now() - start,
    })
  } catch (error) {
    return c.json(
      {
        ok: false,
        error: (error as Error).message,
        latencyMs: Date.now() - start,
      },
      502,
    )
  }
})

// 手动添加模型
providerConnectionApiRoutes.post("/:id/models", async (c) => {
  const connection = getProviderConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Not found" }, 404)

  let payload: Record<string, unknown>
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON" }, 400)
  }

  const publicId =
    typeof payload.publicId === "string" ? payload.publicId.trim() : ""
  if (!publicId) return c.json({ error: "`publicId` is required" }, 400)

  const rawEndpoints =
    Array.isArray(payload.endpoints) ?
      (payload.endpoints as Array<string>).filter((e): e is ModelEndpoint =>
        isModelEndpoint(e),
      )
    : []

  const model = {
    publicId,
    upstreamId:
      typeof payload.upstreamId === "string" && payload.upstreamId ?
        payload.upstreamId
      : publicId,
    name:
      typeof payload.name === "string" && payload.name ?
        payload.name
      : undefined,
    vendor:
      typeof payload.vendor === "string" && payload.vendor ?
        payload.vendor
      : undefined,
    endpoints:
      rawEndpoints.length > 0 ?
        rawEndpoints
      : (["chat"] as Array<ModelEndpoint>),
    enabled: typeof payload.enabled === "boolean" ? payload.enabled : true,
  }

  try {
    await addModel(c.req.param("id"), model)
    return c.json({ connection: sanitizeConnection(connection), model }, 201)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 409)
  }
})

// 更新模型
providerConnectionApiRoutes.put("/:id/models/:publicId", async (c) => {
  const connection = getProviderConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Not found" }, 404)

  const publicId = decodeURIComponent(c.req.param("publicId"))

  let payload: Record<string, unknown>
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON" }, 400)
  }

  const patch: Parameters<typeof updateModel>[2] = {}
  if (typeof payload.upstreamId === "string" && payload.upstreamId)
    patch.upstreamId = payload.upstreamId
  if (typeof payload.name === "string") patch.name = payload.name || undefined
  if (typeof payload.vendor === "string")
    patch.vendor = payload.vendor || undefined
  if (Array.isArray(payload.endpoints)) {
    const eps = (payload.endpoints as Array<string>).filter(
      (e): e is ModelEndpoint => isModelEndpoint(e),
    )
    if (eps.length > 0) patch.endpoints = eps
  }
  if (typeof payload.enabled === "boolean") patch.enabled = payload.enabled

  try {
    const model = await updateModel(c.req.param("id"), publicId, patch)
    return c.json({ connection: sanitizeConnection(connection), model })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

// 删除模型
providerConnectionApiRoutes.delete("/:id/models/:publicId", async (c) => {
  const publicId = decodeURIComponent(c.req.param("publicId"))
  try {
    await deleteModel(c.req.param("id"), publicId)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

// ---- credentials sub-resource -----------------------------------------------

providerConnectionApiRoutes.post("/:id/credentials", async (c) => {
  let payload: Record<string, unknown>
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON" }, 400)
  }

  if (typeof payload.value !== "string" || payload.value === "") {
    return c.json({ error: "`value` is required" }, 400)
  }
  const authMode =
    (
      typeof payload.authMode === "string"
      && isCredentialAuthMode(payload.authMode)
    ) ?
      payload.authMode
    : "bearer"

  try {
    const credential = await addCredential(c.req.param("id"), {
      id: typeof payload.id === "string" ? payload.id : undefined,
      label: typeof payload.label === "string" ? payload.label : undefined,
      authMode,
      headerName:
        typeof payload.headerName === "string" ? payload.headerName : undefined,
      value: payload.value,
      enabled: typeof payload.enabled === "boolean" ? payload.enabled : true,
      priority:
        typeof payload.priority === "number" ? payload.priority : undefined,
      weight: typeof payload.weight === "number" ? payload.weight : undefined,
    })
    return c.json({ credential: sanitizeCredential(credential) }, 201)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 400)
  }
})

providerConnectionApiRoutes.put("/:id/credentials/:credentialId", async (c) => {
  let payload: Record<string, unknown>
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON" }, 400)
  }
  try {
    const credential = await updateCredential(
      c.req.param("id"),
      c.req.param("credentialId"),
      {
        label: typeof payload.label === "string" ? payload.label : undefined,
        authMode:
          (
            typeof payload.authMode === "string"
            && isCredentialAuthMode(payload.authMode)
          ) ?
            payload.authMode
          : undefined,
        headerName:
          typeof payload.headerName === "string" ?
            payload.headerName
          : undefined,
        value: typeof payload.value === "string" ? payload.value : undefined,
        enabled:
          typeof payload.enabled === "boolean" ? payload.enabled : undefined,
        priority:
          typeof payload.priority === "number" ? payload.priority : undefined,
        weight: typeof payload.weight === "number" ? payload.weight : undefined,
      },
    )
    return c.json({ credential: sanitizeCredential(credential) })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

providerConnectionApiRoutes.delete(
  "/:id/credentials/:credentialId",
  async (c) => {
    try {
      await deleteCredential(c.req.param("id"), c.req.param("credentialId"))
      return c.json({ success: true })
    } catch (error) {
      return c.json({ error: (error as Error).message }, 404)
    }
  },
)

providerConnectionApiRoutes.post(
  "/:id/credentials/:credentialId/enable",
  async (c) => {
    const found = findCredential(c.req.param("id"), c.req.param("credentialId"))
    if (!found) return c.json({ error: "Not found" }, 404)
    const previous = { ...found.credential }
    setCredentialEnabled(found.credential, true)
    try {
      await persistProviderConnections()
      return c.json({ credential: sanitizeCredential(found.credential) })
    } catch (error) {
      Object.assign(found.credential, previous)
      logger.error("Failed to persist credential enable:", error)
      return c.json({ error: "Failed to persist credential state" }, 500)
    }
  },
)

providerConnectionApiRoutes.post(
  "/:id/credentials/:credentialId/disable",
  async (c) => {
    const found = findCredential(c.req.param("id"), c.req.param("credentialId"))
    if (!found) return c.json({ error: "Not found" }, 404)
    const previous = { ...found.credential }
    setCredentialEnabled(found.credential, false)
    try {
      await persistProviderConnections()
      return c.json({ credential: sanitizeCredential(found.credential) })
    } catch (error) {
      Object.assign(found.credential, previous)
      logger.error("Failed to persist credential disable:", error)
      return c.json({ error: "Failed to persist credential state" }, 500)
    }
  },
)

providerConnectionApiRoutes.post(
  "/:id/credentials/:credentialId/reset-status",
  async (c) => {
    const found = findCredential(c.req.param("id"), c.req.param("credentialId"))
    if (!found) return c.json({ error: "Not found" }, 404)
    const previous = { ...found.credential }
    resetCredentialStatus(found.credential)
    try {
      await persistProviderConnections()
      return c.json({ credential: sanitizeCredential(found.credential) })
    } catch (error) {
      Object.assign(found.credential, previous)
      logger.error("Failed to persist credential status reset:", error)
      return c.json({ error: "Failed to persist credential state" }, 500)
    }
  },
)

providerConnectionApiRoutes.get("/:id/credentials/:credentialId/value", (c) => {
  const found = findCredential(c.req.param("id"), c.req.param("credentialId"))
  if (!found) return c.json({ error: "Not found" }, 404)
  return c.json({ value: found.credential.value })
})
