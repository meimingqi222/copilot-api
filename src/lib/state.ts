import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  showToken: boolean
  apiKey?: string
  adminPassword?: string
  adminSessionToken?: string
  adminSessionExpiresAt?: number
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  showToken: false,
}
