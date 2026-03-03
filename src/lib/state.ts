import type { Account } from "~/lib/accounts"
import type { User } from "~/lib/users"
import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  // Multi-account support
  accounts: Account[]
  activeAccountIndex: number

  // Multi-user support
  users: User[]

  // Legacy single-key compatibility
  legacyApiKey?: string

  // Legacy single-token (kept for backward compat with auth subcommand)
  githubToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

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
  accountType: "individual",
  manualApprove: false,
  showToken: false,
}
