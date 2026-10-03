import { getBuiltinProviderModule } from "~/services/providers/builtins"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import { isOAuthProviderId, type OAuthProviderId } from "~/lib/provider-config"
import {
  getConnectionOAuthAccessToken,
  getConnectionProvider,
} from "~/lib/provider-connections"

import { getOAuthFallbackModelsForConnection } from "./model-catalog"

// ── Connection 原生版本 ───────────────────────────────────────

/**
 * Connection 原生版本:发现 OAuth connection 的模型列表。
 * 分发权在各 provider 模块:codex/antigravity/claude 自带上游模型端点的
 * discoverModels;没有上游列表端点的 provider 不声明 discoverModels,
 * 直接落模块自带的静态 catalog 兜底。
 */
export async function discoverOAuthModelsForConnection(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<ModelMapping>> {
  const provider = getConnectionProvider(connection)
  if (!provider || !isOAuthProviderId(provider)) {
    return []
  }

  const discoverModels = getBuiltinProviderModule(provider)?.discoverModels
  if (!discoverModels) {
    return getOAuthFallbackModelsForConnection(provider)
  }

  // 没有可用 access token 时上游端点必然 401:直接回落,不发起请求。
  if (!getConnectionOAuthAccessToken(connection)) {
    return getOAuthFallbackModelsForConnection(provider)
  }

  try {
    // 上游模型端点是权威目录。失败时回落到模块的静态 catalog —— 宁可给出
    // 可能过期的列表,也不要因为一次网络抖动把模型表清空。
    return await discoverModels(connection, signal)
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
