import type { Account, AccountProvider } from "~/lib/accounts"
import type { User } from "~/lib/users"
import type { ModelsResponse } from "~/services/copilot/get-models"

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

  provider: AccountProvider
  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  codebuffBaseUrl: string
  codebuffAuthToken?: string
  codebuffCliVersion: string
  codebuffAgentId: string
  codebuffModel: string
  codebuffCostMode: string
  codebuffAllowFallbacks: boolean

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
  codebuffBaseUrl: "https://www.codebuff.com",
  codebuffCliVersion: "0.0.33",
  codebuffAgentId: "base",
  codebuffModel: "z-ai/glm-5.1",
  codebuffCostMode: "normal",
  codebuffAllowFallbacks: true,
  manualApprove: false,
  showToken: false,
}
