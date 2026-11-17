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

interface WindsurfRuntimeSettings {
  apiKey: string | undefined
  baseUrl: string | undefined
  defaultModel: string | undefined
}

interface WindsurfConnectionSettings {
  baseUrl?: string
  defaultModel?: string
  cacheKeepalive?: boolean
  cacheKeepaliveIntervalSeconds?: number
  cacheKeepaliveMaxPings?: number
}

/** Paid background requests are opt-in; provider defaults never enable them. */
export function resolveWindsurfCacheKeepaliveSettings(
  connection: ProviderConnection,
): { enabled: boolean; intervalMs: number; maxPings: number } {
  const settings = connection.metadata?.settings as
    | WindsurfConnectionSettings
    | undefined
  const seconds = settings?.cacheKeepaliveIntervalSeconds
  const max = settings?.cacheKeepaliveMaxPings
  return {
    enabled: settings?.cacheKeepalive === true,
    intervalMs:
      ((
        typeof seconds === "number"
        && Number.isFinite(seconds)
        && seconds >= 30
        && seconds <= 299
      ) ?
        seconds
      : 285) * 1000,
    maxPings:
      (
        typeof max === "number"
        && Number.isInteger(max)
        && max >= 1
        && max <= 50
      ) ?
        max
      : 6,
  }
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
