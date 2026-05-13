/**
 * Admin API: Provider Connections
 *
 * 通用 provider connection 的 CRUD 与 credential 子资源管理。
 * 与 legacy `accounts` API 并存,不互相干扰。
 */

import consola from "consola"
import { Hono } from "hono"

import {
  addCredential,
  createConnection,
  deleteConnection,
  deleteCredential,
  findCredential,
  getProviderConnection,
  isCredentialAuthMode,
  isProviderProtocol,
  listProviderConnections,
  persistProviderConnections,
  resetCredentialStatus,
  sanitizeConnection,
  sanitizeCredential,
  setCredentialEnabled,
  updateConnection,
  updateCredential,
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
  const connection = getProviderConnection(c.req.param("id"))
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

  const previous = structuredClone(connection)
  try {
    const discovered = await adapter.discoverModels(connection, usable)
    const mode = connection.modelDiscovery?.mode ?? "merge"
    const existing = connection.models ?? []
    if (mode === "replace") {
      connection.models = discovered
    } else if (mode === "manual-only") {
      // 不修改 models
    } else {
      // merge: 已存在的 publicId 优先
      const map = new Map(existing.map((m) => [m.publicId, m]))
      for (const m of discovered) {
        if (!map.has(m.publicId)) map.set(m.publicId, m)
      }
      connection.models = [...map.values()]
    }
    connection.lastModelDiscoveryAt = Date.now()
    connection.lastModelDiscoveryError = undefined
    await persistProviderConnections()
    return c.json({
      connection: sanitizeConnection(connection),
      discovered: discovered.length,
    })
  } catch (error) {
    Object.assign(connection, previous, {
      lastModelDiscoveryError: (error as Error).message,
    })
    await persistProviderConnections().catch((persistError: unknown) => {
      consola.error("Failed to persist discovery error:", persistError)
    })
    return c.json({ error: (error as Error).message }, 502)
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
      consola.error("Failed to persist credential enable:", error)
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
      consola.error("Failed to persist credential disable:", error)
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
      consola.error("Failed to persist credential status reset:", error)
      return c.json({ error: "Failed to persist credential state" }, 500)
    }
  },
)
