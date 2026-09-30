/**
 * ProviderConnection 的模型端点能力查询。
 *
 * 单一事实来源:调度层(buildRouteTargets 选端点)与直连 adapter 的
 * endpoint 判定都从这里取答案,不再各自维护一份状态。
 */

import type {
  ModelEndpoint,
  ProviderConnection,
} from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import {
  getOAuthProviderDescriptor,
  isOAuthProviderId,
} from "~/lib/provider-config"
import { state } from "~/lib/state"

import {
  canonicalModelId,
  canonicalNativeModelId,
  parseModelReference,
} from "./model-reference"

/** `state.models.data[].supported_endpoints` 里的 URL 形式端点。 */
const URL_TO_ENDPOINT: Record<string, ModelEndpoint> = {
  "/chat/completions": "chat",
  "/v1/chat/completions": "chat",
  "/responses": "responses",
  "/v1/responses": "responses",
  "/v1/messages": "messages",
  "/v1/embeddings": "embeddings",
}

/**
 * 该 connection 上此模型声明的端点集合。
 *
 * - `connection.models` 是首选来源;未命中时回退到 `state.models`
 *   目录(未加载 models 的 connection 只有这里能给出答案)。
 * - `endpoints: []` 沿用历史语义:只有 chat。
 * - OAuth provider 的 `native_responses` 特性是模型目录之外的额外能力
 *   声明,单独并入。
 * - 两边都没有信息时返回空数组,调用方应视为“未知”。
 */
export function connectionModelEndpoints(
  modelId: string,
  connection: ProviderConnection,
): Array<ModelEndpoint> {
  const endpoints = new Set<ModelEndpoint>()
  for (const endpoint of declaredModelEndpoints(modelId, connection)) {
    endpoints.add(endpoint)
  }
  if (oauthConnectionSupportsNativeResponses(connection)) {
    endpoints.add("responses")
  }
  return [...endpoints]
}

/** 该 connection 上此模型是否可用于指定端点。 */
export function connectionModelSupportsEndpoint(
  modelId: string,
  connection: ProviderConnection,
  endpoint: ModelEndpoint,
): boolean {
  return connectionModelEndpoints(modelId, connection).includes(endpoint)
}

function declaredModelEndpoints(
  modelId: string,
  connection: ProviderConnection,
): Array<ModelEndpoint> {
  const nativeId = parseModelReference(modelId).nativeModelId
  const mapping = connection.models?.find(
    (model) => canonicalNativeModelId(model.publicId) === nativeId,
  )
  if (mapping) {
    return mapping.endpoints.length > 0 ? mapping.endpoints : ["chat"]
  }

  // state.models 与 connection.models 同源(由 cacheModels 汇总),但测试
  // 与尚未加载 models 的 connection 只有目录可用。
  const cached = state.models?.data.find(
    (model) => canonicalModelId(model.id) === canonicalModelId(modelId),
  )
  return (cached?.supported_endpoints ?? []).flatMap((endpoint) => {
    const mapped = URL_TO_ENDPOINT[endpoint]
    return mapped ? [mapped] : []
  })
}

function oauthConnectionSupportsNativeResponses(
  connection: ProviderConnection,
): boolean {
  const provider = getConnectionProvider(connection)
  if (!provider || !isOAuthProviderId(provider)) {
    return false
  }
  return getOAuthProviderDescriptor(provider).features.includes(
    "native_responses",
  )
}
