/**
 * 模型引用解析。
 *
 * 支持三种形式:
 *   - `model-name` 不指定 connection
 *   - `connectionId/model-name` 强制 connection
 *   - alias(在 ModelMapping.aliases 中)
 *
 * 解析时优先匹配已注册的 ProviderConnection.id,fallback 到 legacy ProviderId
 * (保留 `copilot/` `windsurf/` `codebuff/` 兼容)。
 */

import type { Account } from "~/lib/accounts"

import { getAccountModelPrefix, listAccounts } from "~/lib/accounts"
import { isProviderId, type ProviderId } from "~/lib/provider-config"
import {
  getProviderConnection,
  listProviderConnections,
} from "~/lib/provider-connections"

export interface ParsedModelRef {
  /** 命中已注册 connection 时的 connection id;否则 undefined。 */
  connectionId?: string
  /** 命中 legacy provider id 时填充(用于兼容现有 account 路由)。 */
  legacyProvider?: ProviderId
  /** 命中账户自定义 modelPrefix 时填充。 */
  accountPrefix?: string
  /** 去掉 provider 前缀后的模型名(可能仍包含厂商前缀如 `anthropic/claude-...`)。 */
  modelId: string
}

export interface ResolvedModelRouting {
  connectionId?: string
  legacyProvider?: ProviderId
  accountPrefix?: string
  modelId: string
}

export function parseModelRef(modelId: string): ParsedModelRef {
  const trimmed = modelId.trim()
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex <= 0) {
    return { modelId: trimmed }
  }

  const prefix = trimmed.slice(0, slashIndex)
  const rest = trimmed.slice(slashIndex + 1)

  // 1) 优先匹配已注册 connection(大小写敏感优先,fallback 不敏感)
  if (getProviderConnection(prefix)) {
    return { connectionId: prefix, modelId: rest }
  }
  const lower = prefix.toLowerCase()
  const ciMatch = listProviderConnections().find(
    (c) => c.id.toLowerCase() === lower,
  )
  if (ciMatch) {
    return { connectionId: ciMatch.id, modelId: rest }
  }

  // 2) 匹配 legacy provider id(copilot/codebuff/windsurf)
  if (isProviderId(lower)) {
    return { legacyProvider: lower, modelId: rest }
  }

  // 3) 都不匹配:视为模型名整体(可能是 `anthropic/claude-*` 之类的厂商前缀)
  return { modelId: trimmed }
}

export function canonicalNativeModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase()
  if (normalized === "z-ai/glm5" || normalized === "glm5") {
    return "z-ai/glm-5.1"
  }
  return normalized
}

export function parseModelReference(
  modelId: string,
  account?: Account,
): {
  provider?: ProviderId
  nativeModelId: string
} {
  const trimmed = modelId.trim()
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex > 0) {
    const prefix = trimmed.slice(0, slashIndex)
    const rest = trimmed.slice(slashIndex + 1)
    const maybeProvider = prefix.toLowerCase()
    if (isProviderId(maybeProvider)) {
      return {
        provider: maybeProvider,
        nativeModelId: canonicalNativeModelId(rest),
      }
    }
    if (
      account
      && getAccountModelPrefix(account).toLowerCase() === maybeProvider
    ) {
      return {
        nativeModelId: canonicalNativeModelId(rest),
      }
    }
  }
  return {
    nativeModelId: canonicalNativeModelId(trimmed),
  }
}

export function resolveModelRouting(
  modelId: string,
  accounts: Array<Account> = listAccounts(),
): ResolvedModelRouting {
  const ref = parseModelRef(modelId)
  if (ref.connectionId || ref.legacyProvider) {
    return {
      connectionId: ref.connectionId,
      legacyProvider: ref.legacyProvider,
      modelId: ref.modelId,
    }
  }

  const slashIndex = modelId.indexOf("/")
  if (slashIndex > 0) {
    const prefix = modelId.slice(0, slashIndex)
    const rest = modelId.slice(slashIndex + 1).trim()
    if (rest) {
      for (const account of accounts) {
        if (
          getAccountModelPrefix(account).toLowerCase() === prefix.toLowerCase()
        ) {
          return {
            accountPrefix: prefix,
            modelId: rest,
          }
        }
      }
    }
  }

  return { modelId: ref.modelId }
}
