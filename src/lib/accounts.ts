import type { ProviderId } from "~/lib/provider-config"

import { isProviderId } from "~/lib/provider-config"
import { state } from "~/lib/state"

export type AccountProvider = ProviderId
export type AccountQuotaState = "unknown" | "available" | "exhausted"

export interface AccountRuntimeState {
  copilotToken?: string
  copilotTokenExpiry?: number
  windsurfJwt?: string
  windsurfJwtFetchedAt?: number
  authStatus?: "ready" | "pending" | "error"
  lastError?: string
}

export interface CopilotAccountCredentials {
  githubToken?: string
}

export interface CopilotAccountSettings {
  accountType?: string
}

export interface CodebuffAccountConfig {
  codebuffAuthToken?: string
  codebuffBaseUrl?: string
  codebuffCliVersion?: string
  codebuffAgentId?: string
  codebuffModel?: string
  codebuffCostMode?: string
  codebuffAllowFallbacks?: boolean
}

export interface WindsurfAccountConfig {
  windsurfApiKey?: string
  windsurfBaseUrl?: string
  windsurfAppVersion?: string
  windsurfLsVersion?: string
  windsurfDefaultModel?: string
  windsurfClientName?: string
}

export interface BaseAccount {
  id: string
  label: string
  provider: AccountProvider
  quotaInfo?: QuotaSnapshot
  quotaState?: AccountQuotaState
  quotaExhaustedAt?: number
  availableModels?: Array<AccountModel>
  enabled: boolean
  priority: number
  isExhausted?: boolean
  exhaustedAt?: number
  cooldownUntil?: number
  lastRateLimitAt?: number
  lastRateLimitReason?: string
  createdAt: number
  runtimeState?: AccountRuntimeState
}

export interface CopilotAccount extends BaseAccount {
  provider: "copilot"
  credentials?: CopilotAccountCredentials
  settings?: CopilotAccountSettings
  githubToken?: string
  copilotToken?: string
  copilotTokenExpiry?: number
}

export interface CodebuffAccount extends BaseAccount, CodebuffAccountConfig {
  provider: "codebuff"
  credentials?: {
    authToken?: string
  }
  settings?: {
    baseUrl?: string
    cliVersion?: string
    agentId?: string
    model?: string
    costMode?: string
    allowFallbacks?: boolean
  }
}

export interface WindsurfAccount extends BaseAccount, WindsurfAccountConfig {
  provider: "windsurf"
  credentials?: {
    apiKey?: string
  }
  settings?: {
    baseUrl?: string
    appVersion?: string
    lsVersion?: string
    defaultModel?: string
    clientName?: string
  }
}

export type Account = CopilotAccount | CodebuffAccount | WindsurfAccount

export interface AccountModel {
  id: string
  name: string
  vendor: string
  pickerEnabled: boolean
  pickerCategory?: string
  supportedEndpoints: Array<string>
  provider?: AccountProvider
  upstreamId?: string
}

export interface QuotaSnapshot {
  fetchedAt: number
  premiumInteractionsRemaining?: number
  premiumInteractionsTotal?: number
  chatRemaining?: number
  chatTotal?: number
  completionsRemaining?: number
  completionsTotal?: number
  unlimited: boolean
}

function defaultProvider(provider?: AccountProvider): AccountProvider {
  return provider ?? "copilot"
}

export function getAccountProvider(account: Account): AccountProvider {
  return defaultProvider(account.provider)
}

export function getGitHubToken(account: Account): string | undefined {
  if (account.provider !== "copilot") {
    return undefined
  }
  return account.credentials?.githubToken ?? account.githubToken
}

export function setGitHubToken(
  account: Account,
  githubToken: string | undefined,
): void {
  if (account.provider !== "copilot") {
    return
  }
  account.credentials = {
    ...account.credentials,
    githubToken,
  }
  account.githubToken = githubToken
}

export function getCopilotToken(account: Account): string | undefined {
  if (account.provider !== "copilot") {
    return undefined
  }
  return account.runtimeState?.copilotToken ?? account.copilotToken
}

export function setCopilotToken(
  account: Account,
  copilotToken: string | undefined,
): void {
  if (account.provider !== "copilot") {
    return
  }
  account.runtimeState = {
    ...account.runtimeState,
    copilotToken,
  }
  account.copilotToken = copilotToken
}

export function getCopilotTokenExpiry(account: Account): number | undefined {
  if (account.provider !== "copilot") {
    return undefined
  }
  return account.runtimeState?.copilotTokenExpiry ?? account.copilotTokenExpiry
}

export function setCopilotTokenExpiry(
  account: Account,
  expiry: number | undefined,
): void {
  if (account.provider !== "copilot") {
    return
  }
  account.runtimeState = {
    ...account.runtimeState,
    copilotTokenExpiry: expiry,
  }
  account.copilotTokenExpiry = expiry
}

export function getCodebuffAuthToken(account: Account): string | undefined {
  if (account.provider !== "codebuff") {
    return undefined
  }
  return account.credentials?.authToken ?? account.codebuffAuthToken
}

export function setCodebuffAuthToken(
  account: Account,
  authToken: string | undefined,
): void {
  if (account.provider !== "codebuff") {
    return
  }
  account.credentials = {
    ...account.credentials,
    authToken,
  }
  account.codebuffAuthToken = authToken
}

export function getWindsurfApiKey(account: Account): string | undefined {
  if (account.provider !== "windsurf") {
    return undefined
  }
  return account.credentials?.apiKey ?? account.windsurfApiKey
}

export function setWindsurfApiKey(
  account: Account,
  apiKey: string | undefined,
): void {
  if (account.provider !== "windsurf") {
    return
  }
  account.credentials = {
    ...account.credentials,
    apiKey,
  }
  account.windsurfApiKey = apiKey
}

export function getWindsurfJwt(account: Account): string | undefined {
  if (account.provider !== "windsurf") {
    return undefined
  }
  return account.runtimeState?.windsurfJwt
}

export function setWindsurfJwt(
  account: Account,
  jwt: string | undefined,
): void {
  if (account.provider !== "windsurf") {
    return
  }
  account.runtimeState = {
    ...account.runtimeState,
    windsurfJwt: jwt,
    windsurfJwtFetchedAt: jwt ? Date.now() : undefined,
  }
}

// eslint-disable-next-line complexity
export function getCodebuffSettings(account: Account) {
  if (account.provider !== "codebuff") {
    return undefined
  }
  const defaults = state.providerDefaults.codebuff
  return {
    authToken: getCodebuffAuthToken(account) ?? defaults.authToken,
    baseUrl:
      account.settings?.baseUrl ?? account.codebuffBaseUrl ?? defaults.baseUrl,
    cliVersion:
      account.settings?.cliVersion
      ?? account.codebuffCliVersion
      ?? defaults.cliVersion,
    agentId:
      account.settings?.agentId ?? account.codebuffAgentId ?? defaults.agentId,
    model: account.settings?.model ?? account.codebuffModel ?? defaults.model,
    costMode:
      account.settings?.costMode
      ?? account.codebuffCostMode
      ?? defaults.costMode,
    allowFallbacks:
      account.settings?.allowFallbacks
      ?? account.codebuffAllowFallbacks
      ?? defaults.allowFallbacks,
  }
}

// eslint-disable-next-line complexity
export function getWindsurfSettings(account: Account) {
  if (account.provider !== "windsurf") {
    return undefined
  }
  const defaults = state.providerDefaults.windsurf
  return {
    apiKey: getWindsurfApiKey(account) ?? defaults.apiKey,
    baseUrl:
      account.settings?.baseUrl ?? account.windsurfBaseUrl ?? defaults.baseUrl,
    appVersion:
      account.settings?.appVersion
      ?? account.windsurfAppVersion
      ?? defaults.appVersion,
    lsVersion:
      account.settings?.lsVersion
      ?? account.windsurfLsVersion
      ?? defaults.lsVersion,
    defaultModel:
      account.settings?.defaultModel
      ?? account.windsurfDefaultModel
      ?? defaults.defaultModel,
    clientName:
      account.settings?.clientName
      ?? account.windsurfClientName
      ?? defaults.clientName,
  }
}

export function canonicalModelId(modelId: string): string {
  const parsed = parseModelReference(modelId)
  return parsed.provider ?
      `${parsed.provider}/${parsed.nativeModelId}`
    : parsed.nativeModelId
}

export function canonicalNativeModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase()
  if (normalized === "z-ai/glm5" || normalized === "glm5") {
    return "z-ai/glm-5.1"
  }
  return normalized
}

export function parseModelReference(modelId: string): {
  provider?: AccountProvider
  nativeModelId: string
} {
  const trimmed = modelId.trim()
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex > 0) {
    const maybeProvider = trimmed.slice(0, slashIndex).toLowerCase()
    if (isProviderId(maybeProvider)) {
      return {
        provider: maybeProvider,
        nativeModelId: canonicalNativeModelId(trimmed.slice(slashIndex + 1)),
      }
    }
  }
  return {
    nativeModelId: canonicalNativeModelId(trimmed),
  }
}
