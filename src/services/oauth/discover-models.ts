import type { AccountModel } from "~/lib/provider-connections"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import { isOAuthProviderId, type OAuthProviderId } from "~/lib/provider-config"
import {
  getConnectionOAuthAccessToken,
  getConnectionProvider,
} from "~/lib/provider-connections"
import { getAntigravityModelsForConnection } from "~/services/antigravity/get-models"
import { getClaudeModelsForConnection } from "~/services/claude/get-models"
import { getCodexModelsForConnection } from "~/services/codex/get-models"

import { getOAuthFallbackModelsForConnection } from "./model-catalog"

// ── Connection 原生版本 ───────────────────────────────────────

function accountModelsToMappings(
  models: Array<AccountModel>,
): Array<ModelMapping> {
  return models.map((m) => ({
    publicId: m.id,
    upstreamId: m.upstreamId || m.id,
    name: m.name,
    vendor: m.vendor,
    enabled: true,
    pickerEnabled: m.pickerEnabled,
    pickerCategory: m.pickerCategory,
    endpoints: accountModelEndpointsToMappingEndpoints(m.supportedEndpoints),
  }))
}

function accountModelEndpointsToMappingEndpoints(
  supported: Array<string>,
): Array<ModelMapping["endpoints"][number]> {
  const endpoints: Array<ModelMapping["endpoints"][number]> = []
  for (const ep of supported) {
    if (ep.includes("chat/completions")) endpoints.push("chat")
    else if (ep.includes("messages")) endpoints.push("messages")
    else if (ep.includes("responses")) endpoints.push("responses")
    else if (ep.includes("embeddings")) endpoints.push("embeddings")
    else if (ep.includes("images")) endpoints.push("images")
    else if (ep.includes("videos")) endpoints.push("videos")
  }
  if (endpoints.length === 0) endpoints.push("chat")
  return endpoints
}

/**
 * Connection 原生版本:发现 OAuth connection 的模型列表。
 * codex/antigravity/claude 使用 connection 原生发现函数(上游模型端点),
 * 其余 provider 直接使用 connection 原生 fallback。
 */
export async function discoverOAuthModelsForConnection(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<ModelMapping>> {
  const provider = getConnectionProvider(connection)
  if (!provider || !isOAuthProviderId(provider)) {
    return []
  }

  if (!getConnectionOAuthAccessToken(connection)) {
    return getOAuthFallbackModelsForConnection(provider)
  }

  try {
    switch (provider) {
      case "codex": {
        return accountModelsToMappings(
          await getCodexModelsForConnection(connection, signal),
        )
      }
      case "antigravity": {
        return accountModelsToMappings(
          await getAntigravityModelsForConnection(connection, signal),
        )
      }
      case "claude": {
        // 上游 /v1/models 是权威目录。失败时下面的 catch 会回落到静态
        // catalog —— 宁可给出可能过期的列表,也不要因为一次网络抖动把
        // 模型表清空。
        return accountModelsToMappings(
          await getClaudeModelsForConnection(connection, signal),
        )
      }
      default: {
        // 没有上游模型端点的 provider：catalog 兜底。
        // minimax 的 fallback 会先查 models.dev 的 coding-plan 条目，
        // 所以这里拿到的其实是热更新的目录而非纯粹内嵌表。
        return getOAuthFallbackModelsForConnection(provider)
      }
    }
  } catch {
    return getOAuthFallbackModelsForConnection(provider)
  }
}

/**
 * Connection 原生版本:返回 OAuth connection 的 catalog fallback 模型。
 */
export function getOAuthCatalogModelsForConnection(
  connection: ProviderConnection,
): Array<ModelMapping> {
  const provider = getConnectionProvider(connection)
  if (!provider || !isOAuthProviderId(provider)) {
    return []
  }
  return getOAuthFallbackModelsForConnection(provider as OAuthProviderId)
}

/** 重新导出 isOAuthConnection 供外部使用。 */
export { isOAuthConnection } from "~/lib/provider-connections"
