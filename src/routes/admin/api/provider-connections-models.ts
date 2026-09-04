/**
 * Admin API: Provider Connections — 模型相关路由
 *
 * 包含:触发自动模型发现、手动添加/更新/删除模型、批量添加模型、
 * AI 智能解析模型清单。
 * 拆分自 provider-connections.ts 以满足行数限制。
 */

import { Hono } from "hono"

import { logger } from "~/lib/logger"
import {
  type ApiCredential,
  addModel,
  applyDiscoveredModels,
  defaultEndpointsForProtocol,
  deleteModel,
  getProviderConnection,
  isModelEndpoint,
  listProviderConnections,
  type ModelEndpoint,
  type ModelMapping,
  type ProviderConnection,
  type RouteTarget,
  sanitizeConnection,
  setDiscoveryError,
  updateModel,
} from "~/lib/provider-connections"
import { isCredentialAvailable } from "~/lib/provider-connections/availability"
import { readJsonBody } from "~/lib/request-body"
import {
  extractJsonArray,
  modelToTestTarget,
} from "~/routes/admin/api/provider-connections-helpers"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

export const providerConnectionModelRoutes = new Hono()

// 触发自动模型发现
providerConnectionModelRoutes.post("/:id/refresh-models", async (c) => {
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

// 手动添加模型
providerConnectionModelRoutes.post("/:id/models", async (c) => {
  const connection = getProviderConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Not found" }, 404)

  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(c.req.raw)
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
providerConnectionModelRoutes.post("/:id/models/batch", async (c) => {
  const connection = getProviderConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Not found" }, 404)

  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(c.req.raw)
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
providerConnectionModelRoutes.post("/parse-models", async (c) => {
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
providerConnectionModelRoutes.put("/:id/models/:publicId", async (c) => {
  const connection = getProviderConnection(c.req.param("id"))
  if (!connection) return c.json({ error: "Not found" }, 404)

  const publicId = decodeURIComponent(c.req.param("publicId"))

  let payload: Record<string, unknown>
  try {
    payload = await readJsonBody(c.req.raw)
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
providerConnectionModelRoutes.delete("/:id/models/:publicId", async (c) => {
  const publicId = decodeURIComponent(c.req.param("publicId"))
  try {
    await deleteModel(c.req.param("id"), publicId)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})
