import type { Account, AccountProvider } from "~/lib/accounts"
import type { ProviderId } from "~/lib/provider-config"
import type { User } from "~/lib/users"
import type { ModelsResponse } from "~/services/copilot/get-models"

interface CodebuffProviderDefaults {
  authToken?: string
  baseUrl: string
  cliVersion: string
  agentId: string
  model: string
  costMode: string
  allowFallbacks: boolean
}

interface WindsurfProviderDefaults {
  apiKey?: string
  baseUrl: string
  appVersion: string
  lsVersion: string
  defaultModel: string
  clientName: string
}

export interface State {
  // Multi-account support
  accounts: Array<Account>
  activeAccountIndex: number

  // Multi-user support
  users: Array<User>

  // Legacy single-key compatibility
  legacyApiKey?: string

  // Legacy single-token (kept for backward compat with auth subcommand)
  githubToken?: string

  // Deprecated global provider selector. Kept for backward compatibility only.
  provider: AccountProvider
  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  providerDefaults: {
    codebuff: CodebuffProviderDefaults
    windsurf: WindsurfProviderDefaults
  }

  // Deprecated flat defaults kept for compatibility with older tests/callers.
  codebuffBaseUrl: string
  codebuffAuthToken?: string
  codebuffCliVersion: string
  codebuffAgentId: string
  codebuffModel: string
  codebuffCostMode: string
  codebuffAllowFallbacks: boolean

  defaultProvider?: ProviderId

  manualApprove: boolean
  showToken: boolean
  // Legacy single api key (kept for backward compat)
  apiKey?: string
  adminPassword?: string
  adminSessionToken?: string
  adminSessionExpiresAt?: number
}

export const state: State = {
  accounts: [],
  activeAccountIndex: 0,
  users: [],
  provider: "copilot",
  accountType: "individual",
  providerDefaults: {
    codebuff: {
      baseUrl: "https://www.codebuff.com",
      cliVersion: "0.0.33",
      agentId: "base",
      model: "z-ai/glm-5.1",
      costMode: "normal",
      allowFallbacks: true,
    },
    windsurf: {
      baseUrl: "https://server.self-serve.windsurf.com",
      appVersion: "1.48.2",
      lsVersion: "2.0.1050",
      defaultModel: "swe-1-6-fast",
      clientName: "windsurf-next",
    },
  },
  get codebuffBaseUrl() {
    return this.providerDefaults.codebuff.baseUrl
  },
  set codebuffBaseUrl(v: string) {
    this.providerDefaults.codebuff.baseUrl = v
  },
  get codebuffAuthToken() {
    return this.providerDefaults.codebuff.authToken
  },
  set codebuffAuthToken(v: string | undefined) {
    this.providerDefaults.codebuff.authToken = v
  },
  get codebuffCliVersion() {
    return this.providerDefaults.codebuff.cliVersion
  },
  set codebuffCliVersion(v: string) {
    this.providerDefaults.codebuff.cliVersion = v
  },
  get codebuffAgentId() {
    return this.providerDefaults.codebuff.agentId
  },
  set codebuffAgentId(v: string) {
    this.providerDefaults.codebuff.agentId = v
  },
  get codebuffModel() {
    return this.providerDefaults.codebuff.model
  },
  set codebuffModel(v: string) {
    this.providerDefaults.codebuff.model = v
  },
  get codebuffCostMode() {
    return this.providerDefaults.codebuff.costMode
  },
  set codebuffCostMode(v: string) {
    this.providerDefaults.codebuff.costMode = v
  },
  get codebuffAllowFallbacks() {
    return this.providerDefaults.codebuff.allowFallbacks
  },
  set codebuffAllowFallbacks(v: boolean) {
    this.providerDefaults.codebuff.allowFallbacks = v
  },
  manualApprove: false,
  showToken: false,
}
