import type { Account, AccountModel, OAuthAccount } from "~/lib/legacy-accounts"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import { getOAuthAccessToken, isOAuthAccount } from "~/lib/legacy-accounts"
import { isOAuthProviderId, type OAuthProviderId } from "~/lib/provider-config"
import {
  getConnectionOAuthAccessToken,
  getConnectionProvider,
} from "~/lib/provider-connections"
import {
  getAntigravityModelsForAccount,
  getAntigravityModelsForConnection,
} from "~/services/antigravity/get-models"
import {
  getCodexModelsForAccount,
  getCodexModelsForConnection,
} from "~/services/codex/get-models"

import {
  getOAuthFallbackModels,
  getOAuthFallbackModelsForConnection,
} from "./model-catalog"

export async function discoverOAuthModels(
  account: Account,
  signal?: AbortSignal,
): Promise<Array<AccountModel>> {
  if (!isOAuthAccount(account)) {
    return []
  }

  if (!getOAuthAccessToken(account)) {
    return getOAuthFallbackModels(account)
  }

  try {
    switch (account.provider) {
      case "codex": {
        return await getCodexModelsForAccount(account, signal)
      }
      case "antigravity": {
        return await getAntigravityModelsForAccount(account, signal)
      }
      default: {
        return getOAuthFallbackModels(account)
      }
    }
  } catch {
    return getOAuthFallbackModels(account)
  }
}

export function getOAuthCatalogModels(
  account: OAuthAccount,
): Array<AccountModel> {
  return getOAuthFallbackModels(account)
}

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
 * codex/antigravity 使用 connection 原生发现函数,
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
      default: {
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
