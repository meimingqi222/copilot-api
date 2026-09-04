/**
 * Codebuff 连接级运行时配置解析(Phase 2b)。
 *
 * token 位置:authToken = credential.value(settings.authToken 在
 * Account 模型下即来源于 credentials.authToken,connection 化后对应
 * credential.value);其余字段经 getConnectionSettings(metadata.settings)
 * 逐字段用 providerDefaults 兜底。
 */
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { getConnectionSettings } from "~/lib/provider-connections"
import { state } from "~/lib/state"

export interface CodebuffRuntimeSettings {
  authToken?: string
  baseUrl: string
  cliVersion: string
  agentId: string
  defaultModel: string
  costMode: string
  allowFallbacks: boolean
}

interface CodebuffConnectionSettings {
  baseUrl?: string
  cliVersion?: string
  agentId?: string
  model?: string
  costMode?: string
  allowFallbacks?: boolean
}

export function resolveCodebuffRuntimeSettings(
  connection: ProviderConnection,
  credential: ApiCredential,
): CodebuffRuntimeSettings {
  const settings = getConnectionSettings(connection) as
    | CodebuffConnectionSettings
    | undefined
  const defaults = state.providerDefaults.codebuff
  const normalizedModel = connection.models?.[0]?.publicId ?? settings?.model

  return {
    authToken: (credential.value || undefined) ?? defaults.authToken,
    baseUrl: settings?.baseUrl ?? defaults.baseUrl,
    cliVersion: settings?.cliVersion ?? defaults.cliVersion,
    agentId: settings?.agentId ?? defaults.agentId,
    defaultModel: normalizedModel ?? defaults.model,
    costMode: settings?.costMode ?? defaults.costMode,
    allowFallbacks: settings?.allowFallbacks ?? defaults.allowFallbacks,
  }
}
