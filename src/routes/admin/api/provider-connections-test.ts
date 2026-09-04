/**
 * Admin API: Provider Connections — 连通性测试路由
 *
 * 测试 API 连通性:优先 discoverModels,回退手工模型 chat,再回退 HTTP probe。
 * 拆分自 provider-connections.ts 以满足行数限制。
 */

import { Hono } from "hono"

import {
  getProviderConnection,
  sanitizeCredential,
} from "~/lib/provider-connections"
import {
  clearCredentialErrorStateAfterSuccessfulTest,
  firstEnabledChatModel,
  pickTestModel,
  probeModelsEndpoint,
  testViaAdapter,
} from "~/routes/admin/api/provider-connections-helpers"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

export const providerConnectionTestRoutes = new Hono()

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
providerConnectionTestRoutes.post("/:id/test", async (c) => {
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
