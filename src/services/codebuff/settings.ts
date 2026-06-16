import type { Account } from "~/lib/accounts"

import { getCodebuffSettings } from "~/lib/accounts"
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

export function resolveCodebuffRuntimeSettings(
  account: Account,
): CodebuffRuntimeSettings {
  const settings = getCodebuffSettings(account)
  const defaults = state.providerDefaults.codebuff
  const normalizedModel = account.availableModels?.[0]?.id ?? settings?.model

  return {
    authToken: settings?.authToken ?? defaults.authToken,
    baseUrl: settings?.baseUrl ?? defaults.baseUrl,
    cliVersion: settings?.cliVersion ?? defaults.cliVersion,
    agentId: settings?.agentId ?? defaults.agentId,
    defaultModel: normalizedModel ?? defaults.model,
    costMode: settings?.costMode ?? defaults.costMode,
    allowFallbacks: settings?.allowFallbacks ?? defaults.allowFallbacks,
  }
}
