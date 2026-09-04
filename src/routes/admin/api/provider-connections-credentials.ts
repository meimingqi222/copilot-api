/**
 * Admin API: Provider Connections — credential 子资源路由
 *
 * credential 的增删改查、启用/禁用、状态重置、明文值读取。
 * 拆分自 provider-connections.ts 以满足行数限制。
 */

import { Hono } from "hono"

import { logger } from "~/lib/logger"
import {
  addCredential,
  deleteCredential,
  findCredential,
  isCredentialAuthMode,
  persistProviderConnections,
  resetCredentialStatus,
  sanitizeCredential,
  setCredentialEnabled,
  updateCredential,
} from "~/lib/provider-connections"
import { readJsonBody } from "~/lib/request-body"

export const providerConnectionCredentialRoutes = new Hono()

// ---- credentials sub-resource -----------------------------------------------

providerConnectionCredentialRoutes.post("/:id/credentials", async (c) => {
  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(c.req.raw)
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

providerConnectionCredentialRoutes.put(
  "/:id/credentials/:credentialId",
  async (c) => {
    let payload: Record<string, unknown>
    try {
      payload = await readJsonBody(c.req.raw)
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
          weight:
            typeof payload.weight === "number" ? payload.weight : undefined,
        },
      )
      return c.json({ credential: sanitizeCredential(credential) })
    } catch (error) {
      return c.json({ error: (error as Error).message }, 404)
    }
  },
)

providerConnectionCredentialRoutes.delete(
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

providerConnectionCredentialRoutes.post(
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

providerConnectionCredentialRoutes.post(
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

providerConnectionCredentialRoutes.post(
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

providerConnectionCredentialRoutes.get(
  "/:id/credentials/:credentialId/value",
  (c) => {
    const found = findCredential(c.req.param("id"), c.req.param("credentialId"))
    if (!found) return c.json({ error: "Not found" }, 404)
    return c.json({ value: found.credential.value })
  },
)
