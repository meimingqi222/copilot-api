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
  defaultEndpointsForProtocol,
  deleteConnection,
  deleteCredential,
  deleteModel,
  findCredential,
  getProviderConnection,
  isCredentialAuthMode,
  isModelEndpoint,
  isProviderProtocol,
  listProviderConnections,
  type ApiCredential,
  type ModelEndpoint,
  type ModelMapping,
  persistProviderConnections,
  type ProviderConnection,
  resetCredentialStatus,
  type RouteTarget,
  sanitizeConnection,
  sanitizeCredential,
  setCredentialEnabled,
  setDiscoveryError,
  updateConnection,
  updateCredential,
  updateModel,
} from "~/lib/provider-connections"
import { isCredentialAvailable } from "~/lib/provider-connections/availability"
import { providerConnectionIoRoutes } from "~/routes/admin/api/provider-connection-io"
import {
  clearCredentialErrorStateAfterSuccessfulTest,
  extractJsonArray,
  firstEnabledChatModel,
  modelToTestTarget,
  pickTestModel,
  probeModelsEndpoint,
  testViaAdapter,
} from "~/routes/admin/api/provider-connections-helpers"
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

// Export / import (batch) — see provider-connection-io.ts
providerConnectionApiRoutes.route("/", providerConnectionIoRoutes)

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
//
// 优先顺序:
// 1. 请求体指定 `modelId` → 直接用该模型发最小 chat / messages 请求
// 2. 否则先尝试 `discoverModels`(对支持 /models 的 provider 最经济)
// 3. discovery 失败时,若 connection 已有手工配置的模型,回退用第一个
//    enabled chat/messages 模型发真实最小请求 — 解决无自动发现能力
//    provider(如 Cline)的连通性测试问题
// 4. 都不可行时,fallback 到 plain HTTP probe /models
//
// 成功时会清除该 credential 上残留的 cooldown / lastError（例如历史 429），
// 避免 WebUI 一直显示 upstream 429 警告色。
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

  const requestedModelId =
    typeof body.modelId === "string" && body.modelId ? body.modelId : undefined

  const adapter = getProtocolAdapter(connection.protocol)
  const start = Date.now()
  const timeoutSignal = AbortSignal.timeout(15_000)

  const respondOk = async (payload: Record<string, unknown>) => {
    await clearCredentialErrorStateAfterSuccessfulTest(credential)
    return c.json({
      ok: true,
      latencyMs: Date.now() - start,
      ...payload,
      credential: sanitizeCredential(credential),
    })
  }

  // ── 路径 1: 用户指定了 modelId,直接发 chat 测试 ─────────────────────
  if (requestedModelId && adapter) {
    const target = pickTestModel(connection, requestedModelId)
    if (!target) {
      return c.json(
        { ok: false, error: `Model "${requestedModelId}" not found` },
        400,
      )
    }
    try {
      const method = await testViaAdapter(
        adapter,
        connection,
        credential,
        target,
        timeoutSignal,
      )
      return await respondOk({
        method,
        modelId: target.publicModelId,
      })
    } catch (error) {
      return c.json(
        {
          ok: false,
          error: (error as Error).message,
          latencyMs: Date.now() - start,
          method: "chat",
          modelId: target.publicModelId,
        },
        502,
      )
    }
  }

  // ── 路径 2: 先试 discoverModels ──────────────────────────────────────
  if (adapter?.discoverModels) {
    try {
      await adapter.discoverModels({
        connection,
        credential,
        signal: timeoutSignal,
      })
      return await respondOk({ method: "model-list" })
    } catch (discoveryError) {
      // ── 路径 3: discovery 失败,回退到第一个手工模型发 chat ──────────
      const fallbackTarget = firstEnabledChatModel(connection)
      if (fallbackTarget) {
        try {
          const method = await testViaAdapter(
            adapter,
            connection,
            credential,
            fallbackTarget,
            timeoutSignal,
          )
          return await respondOk({
            method,
            modelId: fallbackTarget.publicModelId,
            discoveryError: (discoveryError as Error).message,
          })
        } catch (error) {
          return c.json(
            {
              ok: false,
              error: (error as Error).message,
              latencyMs: Date.now() - start,
              method: fallbackTarget.endpoint,
              modelId: fallbackTarget.publicModelId,
              discoveryError: (discoveryError as Error).message,
            },
            502,
          )
        }
      }

      // ── 路径 4: 没有手工模型,走 plain HTTP probe ────────────────────
      const probeResult = await probeModelsEndpoint(
        connection,
        credential,
        timeoutSignal,
      )
      if (probeResult.ok) {
        return await respondOk({
          status: probeResult.status,
          method: "http-probe",
        })
      }
      return c.json(
        {
          ok: false,
          status: probeResult.status,
          error: probeResult.error ?? (discoveryError as Error).message,
          latencyMs: Date.now() - start,
          method: "http-probe",
        },
        502,
      )
    }
  }

  // ── 路径 4(adapter 无 discoverModels): plain HTTP probe ──────────────
  const probeResult = await probeModelsEndpoint(
    connection,
    credential,
    timeoutSignal,
  )
  if (probeResult.ok) {
    return await respondOk({
      status: probeResult.status,
      method: "http-probe",
    })
  }
  return c.json(
    {
      ok: false,
      status: probeResult.status,
      error: probeResult.error,
      latencyMs: Date.now() - start,
      method: "http-probe",
    },
    502,
  )
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
      : defaultEndpointsForProtocol(connection.protocol),
    enabled: typeof payload.enabled === "boolean" ? payload.enabled : true,
  }

  try {
    await addModel(c.req.param("id"), model)
    return c.json({ connection: sanitizeConnection(connection), model }, 201)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 409)
  }
})

// 批量添加模型
//
// 请求体: { models: Array<{ publicId, upstreamId?, name?, vendor?, endpoints?, enabled? }> }
// 行为: 已存在的 publicId 跳过(不报错),返回 added / skipped 列表。
// 便于从粘贴的模型清单一次性导入。
providerConnectionApiRoutes.post("/:id/models/batch", async (c) => {
  const connection = getProviderConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Not found" }, 404)

  let payload: Record<string, unknown>
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON" }, 400)
  }

  const input = Array.isArray(payload.models) ? payload.models : []
  if (input.length === 0) {
    return c.json({ error: "`models` array is required" }, 400)
  }

  const existing = new Set((connection.models ?? []).map((m) => m.publicId))
  const added: Array<ModelMapping> = []
  const skipped: Array<{ publicId: string; reason: string }> = []

  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue
    const item = raw as Record<string, unknown>
    const publicId =
      typeof item.publicId === "string" ? item.publicId.trim() : ""
    if (!publicId) {
      skipped.push({ publicId: "", reason: "missing publicId" })
      continue
    }
    if (existing.has(publicId)) {
      skipped.push({ publicId, reason: "already exists" })
      continue
    }

    const rawEndpoints =
      Array.isArray(item.endpoints) ?
        (item.endpoints as Array<string>).filter((e): e is ModelEndpoint =>
          isModelEndpoint(e),
        )
      : []
    const model: ModelMapping = {
      publicId,
      upstreamId:
        typeof item.upstreamId === "string" && item.upstreamId ?
          item.upstreamId
        : publicId,
      name: typeof item.name === "string" && item.name ? item.name : undefined,
      vendor:
        typeof item.vendor === "string" && item.vendor ?
          item.vendor
        : undefined,
      endpoints:
        rawEndpoints.length > 0 ?
          rawEndpoints
        : defaultEndpointsForProtocol(connection.protocol),
      enabled: typeof item.enabled === "boolean" ? item.enabled : true,
    }
    try {
      await addModel(c.req.param("id"), model)
      existing.add(publicId)
      added.push(model)
    } catch (error) {
      skipped.push({
        publicId,
        reason: (error as Error).message,
      })
    }
  }

  return c.json(
    {
      connection: sanitizeConnection(connection),
      added,
      skipped,
    },
    201,
  )
})

// AI 智能解析模型清单
//
// 请求体: { text: string, connectionId?: string, modelId?: string }
// 行为: 用任意一个可用的 chat connection(account/credential)调用 LLM,
//       把用户粘贴的任意格式文本解析为结构化模型列表。
// 返回: { models: Array<{ publicId, upstreamId, name, vendor }> }
//
// 选择调用源的优先级:
// 1. 请求体指定 connectionId + modelId
// 2. 遍历所有 provider connections,取第一个 enabled + 可用 credential + 有 chat 模型的
providerConnectionApiRoutes.post("/parse-models", async (c) => {
  const body = (await c.req
    .json()
    .catch(() => ({}) as Record<string, unknown>)) as Record<string, unknown>
  const text = typeof body.text === "string" ? body.text : ""
  if (!text.trim()) {
    return c.json({ error: "`text` is required" }, 400)
  }

  initializeProtocolAdapters()

  // 找一个可用的 chat 调用源
  const connections = listProviderConnections()
  let target: RouteTarget | undefined
  let connection: ProviderConnection | undefined
  let credential: ApiCredential | undefined

  const requestedConnId =
    typeof body.connectionId === "string" ? body.connectionId : undefined
  const requestedModelId =
    typeof body.modelId === "string" ? body.modelId : undefined

  if (requestedConnId) {
    const conn = connections.find((cn) => cn.id === requestedConnId)
    if (conn) {
      const cred = conn.credentials.find((cr) => isCredentialAvailable(cr))
      const model =
        requestedModelId ?
          conn.models?.find((m) => m.publicId === requestedModelId && m.enabled)
        : conn.models?.find((m) => m.enabled && m.endpoints.includes("chat"))
      if (cred && model) {
        connection = conn
        credential = cred
        target = modelToTestTarget(conn, model)
        target.credentialId = cred.id
      }
    }
  }

  if (!target) {
    for (const conn of connections) {
      if (!conn.enabled) continue
      const cred = conn.credentials.find((cr) => isCredentialAvailable(cr))
      if (!cred) continue
      const model = conn.models?.find(
        (m) => m.enabled && m.endpoints.includes("chat"),
      )
      if (!model) continue
      connection = conn
      credential = cred
      target = modelToTestTarget(conn, model)
      target.credentialId = cred.id
      break
    }
  }

  if (!target || !connection || !credential) {
    return c.json(
      {
        error:
          "No available chat connection found. Please configure and enable a provider connection with a chat model first.",
      },
      400,
    )
  }

  const adapter = getProtocolAdapter(connection.protocol)
  if (!adapter?.createChatCompletions) {
    return c.json(
      { error: `Protocol ${connection.protocol} has no chat capability` },
      400,
    )
  }

  const systemPrompt = `You are a model list parser. Extract all AI/LLM models from the user's text and return ONLY a JSON array (no markdown, no explanation). Each element must be an object: {"publicId": string, "upstreamId": string, "name": string, "vendor": string | null}. Rules:
1. "name" = human-friendly display name (e.g. "DeepSeek V4 Flash"). Use "" if not apparent.
2. "upstreamId" = the full model id exactly as written in the text (e.g. "cline-pass/glm-5.2").
3. If the id contains a "/", split it: prefix -> "vendor", suffix -> "publicId" (e.g. "cline-pass/glm-5.2" => vendor="cline-pass", publicId="glm-5.2", upstreamId="cline-pass/glm-5.2").
4. If no "/", "vendor" = null and "publicId" = "upstreamId" = the id.
5. Return [] if no models are found.
Output format: [{"publicId":"...","upstreamId":"...","name":"...","vendor":"..."}]`

  try {
    const result = await adapter.createChatCompletions({
      target,
      connection,
      credential,
      payload: {
        model: target.upstreamModelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        max_tokens: 2000,
        temperature: 0,
        stream: false,
      },
      signal: AbortSignal.timeout(30_000),
    })

    if (!("response" in result)) {
      return c.json({ error: "Unexpected adapter response (stream)" }, 500)
    }
    const resp = result.response as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = resp.choices?.[0]?.message?.content ?? ""
    const models = extractJsonArray(content)
    return c.json({ models })
  } catch (error) {
    return c.json(
      { error: `AI parse failed: ${(error as Error).message}` },
      502,
    )
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
  if (typeof payload.publicId === "string" && payload.publicId)
    patch.publicId = payload.publicId.trim()
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
