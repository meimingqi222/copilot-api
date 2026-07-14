/**
 * Provider connection export / import helpers + routes.
 * Split out of provider-connections.ts to keep that file under the line limit.
 */
import { Hono } from "hono"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { logger } from "~/lib/logger"
import {
  createConnection,
  deleteConnection,
  getProviderConnection,
  isProviderProtocol,
  listProviderConnections,
} from "~/lib/provider-connections"

export const providerConnectionIoRoutes = new Hono()

/** Export all provider connections including credential secrets. */
providerConnectionIoRoutes.get("/export", (c) => {
  const connections = listProviderConnections()
  const body = JSON.stringify({ version: 1 as const, connections }, null, 2)
  c.header("Content-Type", "application/json; charset=utf-8")
  c.header(
    "Content-Disposition",
    'attachment; filename="copilot-api-provider-connections.json"',
  )
  return c.body(body)
})

/** Export a single provider connection (with secrets). */
providerConnectionIoRoutes.get("/:id/export", (c) => {
  const connection = getProviderConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Not found" }, 404)
  const body = JSON.stringify(
    { version: 1 as const, connections: [connection] },
    null,
    2,
  )
  const safeName = connection.id.replaceAll(/[^\w.-]+/g, "_")
  c.header("Content-Type", "application/json; charset=utf-8")
  c.header(
    "Content-Disposition",
    `attachment; filename="copilot-api-provider-connection-${safeName}.json"`,
  )
  return c.body(body)
})

/** Import provider connections from exported JSON (batch). */
providerConnectionIoRoutes.post("/import", async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON" }, 400)
  }

  const overwrite =
    typeof payload === "object"
    && payload !== null
    && (payload as { overwrite?: unknown }).overwrite === true

  const rawList = extractConnectionsFromImportPayload(payload)
  if (rawList.length === 0) {
    return c.json({ error: "No connections provided in payload." }, 400)
  }

  const imported: Array<string> = []
  const skipped: Array<string> = []
  const failed: Array<{ name: string; reason: string }> = []

  for (const raw of rawList) {
    await importOneConnection(raw, {
      overwrite,
      imported,
      skipped,
      failed,
    })
  }

  if (imported.length > 0) {
    logger.info(
      `Imported ${imported.length} provider connection(s): ${imported.join(", ")}`,
    )
  }

  return c.json({
    ok: true,
    imported: imported.length,
    skipped: skipped.length,
    failed: failed.length,
    details: { imported, skipped, failed },
  })
})

interface ImportBuckets {
  overwrite: boolean
  imported: Array<string>
  skipped: Array<string>
  failed: Array<{ name: string; reason: string }>
}

async function importOneConnection(
  raw: Record<string, unknown>,
  buckets: ImportBuckets,
): Promise<void> {
  const label = connectionLabel(raw, buckets.imported.length)
  try {
    const input = normalizeImportedConnection(raw)
    if (input.id) {
      const existing = getProviderConnection(input.id)
      if (existing) {
        if (!buckets.overwrite) {
          buckets.skipped.push(label)
          return
        }
        await deleteConnection(input.id)
      }
    }
    await createConnection(input)
    buckets.imported.push(label)
  } catch (error) {
    buckets.failed.push({ name: label, reason: (error as Error).message })
  }
}

function connectionLabel(
  raw: Record<string, unknown>,
  importedCount: number,
): string {
  if (typeof raw.name === "string" && raw.name.trim()) return raw.name.trim()
  if (typeof raw.id === "string" && raw.id) return raw.id
  return `connection-${importedCount + 1}`
}

function extractConnectionsFromImportPayload(
  payload: unknown,
): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
  }
  if (typeof payload !== "object" || payload === null) return []
  const obj = payload as Record<string, unknown>
  if (Array.isArray(obj.connections)) {
    return obj.connections.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
  }
  if (typeof obj.baseUrl === "string" && typeof obj.protocol === "string") {
    return [obj]
  }
  return []
}

interface ImportedConnectionInput {
  id?: string
  name: string
  protocol: ProviderConnection["protocol"]
  baseUrl: string
  enabled?: boolean
  priority?: number
  weight?: number
  headers?: Record<string, string>
  modelDiscovery?: ProviderConnection["modelDiscovery"]
  models?: ProviderConnection["models"]
  credentials?: Array<{
    id?: string
    label?: string
    authMode?: ApiCredential["authMode"]
    headerName?: string
    value: string
    enabled?: boolean
    priority?: number
    weight?: number
  }>
}

function pickCredentialValue(cred: Record<string, unknown>): string {
  if (typeof cred.value === "string") return cred.value
  if (typeof cred.apiKey === "string") return cred.apiKey
  if (typeof cred.token === "string") return cred.token
  return ""
}

function normalizeImportedCredential(
  item: unknown,
): ImportedConnectionInput["credentials"] extends Array<infer T> | undefined ?
  T | null
: never {
  if (typeof item !== "object" || item === null) return null
  const cred = item as Record<string, unknown>
  const value = pickCredentialValue(cred)
  if (!value) return null
  const authMode: ApiCredential["authMode"] =
    cred.authMode === "header" ? "header" : "bearer"
  return {
    id: typeof cred.id === "string" ? cred.id : undefined,
    label: typeof cred.label === "string" ? cred.label : undefined,
    authMode,
    headerName:
      typeof cred.headerName === "string" ? cred.headerName : undefined,
    value,
    enabled: typeof cred.enabled === "boolean" ? cred.enabled : true,
    priority: typeof cred.priority === "number" ? cred.priority : undefined,
    weight: typeof cred.weight === "number" ? cred.weight : undefined,
  }
}

function normalizeImportedConnection(
  raw: Record<string, unknown>,
): ImportedConnectionInput {
  let name = ""
  if (typeof raw.name === "string" && raw.name.trim()) name = raw.name.trim()
  else if (typeof raw.id === "string") name = raw.id

  const protocol =
    typeof raw.protocol === "string" && isProviderProtocol(raw.protocol) ?
      raw.protocol
    : null
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : ""

  if (!name) throw new Error("Missing connection name")
  if (!protocol) throw new Error("Invalid or missing protocol")
  if (!baseUrl) throw new Error("Missing baseUrl")

  const credentialsRaw = Array.isArray(raw.credentials) ? raw.credentials : []
  const credentials = credentialsRaw
    .map((item) => normalizeImportedCredential(item))
    .filter((item): item is NonNullable<typeof item> => item !== null)

  const headers =
    (
      raw.headers
      && typeof raw.headers === "object"
      && !Array.isArray(raw.headers)
    ) ?
      (raw.headers as Record<string, string>)
    : undefined

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : undefined,
    name,
    protocol,
    baseUrl,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    priority: typeof raw.priority === "number" ? raw.priority : undefined,
    weight: typeof raw.weight === "number" ? raw.weight : undefined,
    headers,
    modelDiscovery:
      raw.modelDiscovery && typeof raw.modelDiscovery === "object" ?
        (raw.modelDiscovery as ProviderConnection["modelDiscovery"])
      : undefined,
    models:
      Array.isArray(raw.models) ?
        (raw.models as ProviderConnection["models"])
      : undefined,
    credentials: credentials.length > 0 ? credentials : undefined,
  }
}
