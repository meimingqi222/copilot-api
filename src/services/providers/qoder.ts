/**
 * Qoder Provider Runtime。
 *
 * 复用 `createOAuthProviderRuntime` 的配额刷新 / 认证刷新 / 能力判定
 * （qoder / qoder-cn 都在 `OAUTH_PROVIDER_IDS` 里，OAuth 刷新调度直接可用），
 * 只覆盖**模型发现**：Qoder 没有静态模型表，模型只能由登录后的 `model/list`
 * 实时发现，所以必须走 adapter 的 `discoverModels`（codebuddy 的先例），
 * 而不是 `discoverOAuthModelsForConnection` 的 switch 兜底目录。
 *
 * 两个站点（qoder / qoder-cn）共用同一套逻辑，只是 provider id 不同，
 * 所以 runtime 按 provider 参数化生成。
 */

import type { OAuthProviderId } from "~/lib/provider-config"
import { getProtocolAdapter } from "~/services/protocols"

import { createOAuthProviderRuntime } from "./oauth"
import type { ProviderRuntime } from "./runtime"

/** 按 provider id 生成 runtime（"qoder" 或 "qoder-cn"）。 */
export function qoderProviderRuntimeFor(
  providerId: OAuthProviderId,
): ProviderRuntime {
  const base = createOAuthProviderRuntime(providerId)
  return {
    ...base,
    async refreshModels(connection) {
      const adapter = getProtocolAdapter("qoder-native")
      const credential = connection.credentials[0]
      if (adapter?.discoverModels && credential) {
        try {
          const models = await adapter.discoverModels({
            connection,
            credential,
          })
          if (models.length > 0) return models
        } catch {
          // 发现失败时退到 catalog（兜底静态表）。
        }
      }
      return this.getFallbackModels?.(connection) ?? []
    },
  }
}
