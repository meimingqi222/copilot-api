/**
 * Helpers for provider-connections admin routes:
 *   - connectivity test (model discovery / chat probe / http probe)
 *   - AI-powered model list parsing
 *
 * Extracted from provider-connections.ts to keep the route file under the
 * lint line limit.
 */

import type { ProtocolAdapter } from "~/services/protocols/types"

import { logger } from "~/lib/logger"
import {
  type ApiCredential,
  type ModelEndpoint,
  type ModelMapping,
  type ProviderConnection,
  type RouteTarget,
  persistProviderConnections,
  resetCredentialStatus,
} from "~/lib/provider-connections"
import { listProviderConnections } from "~/lib/provider-connections"
import { isCredentialAvailable } from "~/lib/provider-connections/availability"

// ── model → RouteTarget ────────────────────────────────────────────────

function pickPreferredEndpoint(model: ModelMapping): ModelEndpoint {
  if (model.endpoints.includes("chat")) return "chat"
  if (model.endpoints.includes("messages")) return "messages"
  return model.endpoints[0] ?? "chat"
}

// ── payload normalization for nullable fields ──────────────────────────

export function normalizeNullableObject(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === null) return null
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

export function normalizeNullableArray(
  value: unknown,
): Array<unknown> | null | undefined {
  if (value === null) return null
  if (Array.isArray(value)) return value as Array<unknown>
  return undefined
}

export function modelToTestTarget(
  connection: ProviderConnection,
  model: ModelMapping,
): RouteTarget {
  const endpoint = pickPreferredEndpoint(model)
  return {
    connectionId: connection.id,
    connectionName: connection.name,
    protocol: connection.protocol,
    credentialId: "",
    publicModelId: model.publicId,
    upstreamModelId: model.upstreamId,
    endpoint,
    connectionPriority: connection.priority,
    connectionWeight: connection.weight ?? 1,
    credentialPriority: 0,
    credentialWeight: 1,
  }
}

/** 按 publicId 找一个 enabled 且支持 chat/messages 的模型,构造测试用 RouteTarget。 */
export function pickTestModel(
  connection: ProviderConnection,
  modelId: string,
): RouteTarget | undefined {
  const model = connection.models?.find(
    (m) => m.publicId === modelId && m.enabled,
  )
  if (!model) return undefined
  return modelToTestTarget(connection, model)
}

/** 取第一个 enabled 且支持 chat/messages 的模型作为测试目标。 */
export function firstEnabledChatModel(
  connection: ProviderConnection,
): RouteTarget | undefined {
  const model = connection.models?.find(
    (m) =>
      m.enabled && m.endpoints.some((e) => e === "chat" || e === "messages"),
  )
  if (!model) return undefined
  return modelToTestTarget(connection, model)
}

// ── connectivity test helpers ──────────────────────────────────────────

/**
 * 用 adapter 发一个 max_tokens=1 的最小非流式请求来验证连通性。
 * 返回实际使用的 method("chat" | "messages")。
 */
export async function testViaAdapter(
  adapter: ProtocolAdapter,
  connection: ProviderConnection,
  credential: ApiCredential,
  target: RouteTarget,
  signal: AbortSignal,
): Promise<"chat" | "messages"> {
  if (target.endpoint === "messages" && adapter.createMessages) {
    await adapter.createMessages({
      target,
      connection,
      credential,
      payload: {
        model: target.upstreamModelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      },
      signal,
    })
    return "messages"
  }

  if (adapter.createChatCompletions) {
    await adapter.createChatCompletions({
      target,
      connection,
      credential,
      payload: {
        model: target.upstreamModelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      },
      signal,
    })
    return "chat"
  }

  // adapter 没有可用的 create 方法,退回到 HTTP probe
  throw new Error("Adapter has no chat/messages capability")
}

/** 兜底的 plain HTTP probe /models 端点。 */
export async function probeModelsEndpoint(
  connection: ProviderConnection,
  credential: ApiCredential,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const testUrl = `${connection.baseUrl}/models`
  const headers: Record<string, string> = {}
  if (credential.authMode === "header") {
    headers[credential.headerName ?? "Authorization"] = credential.value
  } else {
    headers["Authorization"] = `Bearer ${credential.value}`
  }
  try {
    const res = await fetch(testUrl, { headers, signal })
    return { ok: res.ok, status: res.status }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: (error as Error).message,
    }
  }
}

// ── AI parse helpers ───────────────────────────────────────────────────

/** 找一个可用的 chat 调用源用于 AI 解析。 */
export function findChatTargetForParse():
  | {
      connection: ProviderConnection
      credential: ApiCredential
      target: RouteTarget
    }
  | undefined {
  for (const conn of listProviderConnections()) {
    if (!conn.enabled) continue
    const cred = conn.credentials.find((cr) => isCredentialAvailable(cr))
    if (!cred) continue
    const model = conn.models?.find(
      (m) => m.enabled && m.endpoints.includes("chat"),
    )
    if (!model) continue
    const target = modelToTestTarget(conn, model)
    target.credentialId = cred.id
    return { connection: conn, credential: cred, target }
  }
  return undefined
}

/** 从 LLM 返回内容中提取 JSON 数组,容忍 markdown code fence。 */
export function extractJsonArray(
  content: string,
): Array<Record<string, unknown>> {
  let s = content.trim()
  // 去除 ```json ... ``` 或 ``` ... ```(不混合 \s* 与 [\s\S]*? 避免 polynomial backtracking)
  const fence = s.match(/```(?:json)?([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  // 找到第一个 [ 到最后一个 ]
  const start = s.indexOf("[")
  const end = s.lastIndexOf("]")
  if (start === -1 || end === -1 || end <= start) return []
  const jsonStr = s.slice(start, end + 1)
  try {
    const parsed: unknown = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is Record<string, unknown> => x !== null && typeof x === "object",
    )
  } catch {
    return []
  }
}

/**
 * Connectivity test succeeded → drop stale cooldown / lastError so the UI
 * no longer shows an orange/red "upstream 429" badge after a healthy probe.
 * Does not re-enable intentionally disabled credentials.
 */
export async function clearCredentialErrorStateAfterSuccessfulTest(
  credential: ApiCredential,
): Promise<void> {
  const hadStickyError =
    credential.status === "cooldown"
    || credential.status === "quota_exhausted"
    || credential.status === "auth_error"
    || Boolean(credential.lastError)
    || credential.cooldownUntil !== undefined
    || credential.lastRateLimitAt !== undefined

  if (!hadStickyError) return

  resetCredentialStatus(credential)
  try {
    await persistProviderConnections()
  } catch (error) {
    logger.warn(
      "Failed to persist credential recovery after successful connectivity test:",
      error,
    )
  }
}
