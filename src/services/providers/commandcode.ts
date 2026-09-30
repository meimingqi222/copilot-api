/**
 * Command Code Plan Provider Runtime。
 *
 * 复用 `createOAuthProviderRuntime` 的配额/认证刷新，只覆盖 **模型发现**：
 * Command Code 没有静态模型表，模型只能从 Provider API 的 `/models` 实时
 * 发现，所以走 adapter 的 `discoverModels`（qoder 的先例）。
 */

import { getProtocolAdapter } from "~/services/protocols"

import { createOAuthProviderRuntime } from "./oauth"
import type { ProviderRuntime } from "./runtime"

const base = createOAuthProviderRuntime("commandcode-plan")

export const commandCodeProviderRuntime: ProviderRuntime = {
  ...base,
  async refreshModels(connection) {
    const adapter = getProtocolAdapter("commandcode-native")
    const credential = connection.credentials[0]
    if (adapter?.discoverModels && credential) {
      try {
        const models = await adapter.discoverModels({ connection, credential })
        if (models.length > 0) return models
      } catch {
        // 发现失败 → 退到 catalog（commandcode 的目录是空的）→ 无模型。
      }
    }
    return this.getFallbackModels?.(connection) ?? []
  },
}
