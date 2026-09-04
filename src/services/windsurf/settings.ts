/**
 * Windsurf 连接级运行时配置解析(Phase 2b)。
 *
 * token 位置:apiKey = credential.value(Account 模型下 credentials.apiKey
 * 对应 credential.value);baseUrl/defaultModel 经 getConnectionSettings
 * (metadata.settings)逐字段用 providerDefaults 兜底。
 */
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { getConnectionSettings } from "~/lib/provider-connections"
import { state } from "~/lib/state"

export interface WindsurfRuntimeSettings {
  apiKey: string | undefined
  baseUrl: string | undefined
  defaultModel: string | undefined
}

interface WindsurfConnectionSettings {
  baseUrl?: string
  defaultModel?: string
}

export function resolveWindsurfRuntimeSettings(
  connection: ProviderConnection,
  credential: ApiCredential,
): WindsurfRuntimeSettings | undefined {
  if (connection.protocol !== "windsurf-native") return undefined
  const defaults = state.providerDefaults.windsurf
  const settings = getConnectionSettings(connection) as
    | WindsurfConnectionSettings
    | undefined
  return {
    apiKey: (credential.value || undefined) ?? defaults.apiKey,
    baseUrl: settings?.baseUrl ?? defaults.baseUrl,
    defaultModel: settings?.defaultModel ?? defaults.defaultModel,
  }
}
