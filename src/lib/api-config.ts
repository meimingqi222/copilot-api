import { randomUUID } from "node:crypto"

import type { Account } from "./legacy-accounts"
import type { ProviderConnection } from "./provider-connections"
import type { State } from "./state"

import { getCopilotToken } from "./legacy-accounts"
import { getConnectionCopilotToken } from "./provider-connections"
import { state as globalState } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION = "0.26.7"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

const API_VERSION = "2025-04-01"

const ACCOUNT_TYPE_URLS: Record<string, string> = {
  individual: "https://api.githubcopilot.com",
  business: "https://api.business.githubcopilot.com",
  enterprise: "https://api.enterprise.githubcopilot.com",
}

export const copilotBaseUrl = (state: State): string => {
  const url = ACCOUNT_TYPE_URLS[state.accountType]
  if (!url) {
    throw new Error(
      `Invalid account type "${state.accountType}". Must be one of: ${Object.keys(ACCOUNT_TYPE_URLS).join(", ")}`,
    )
  }
  return url
}

/**
 * Connection 原生版本的 Copilot 请求头构造(Phase 2a)。
 * token 直接来自 credential.value,不再经由 Account 派生。
 */
export const copilotHeadersForToken = (
  token: string | undefined,
  vision: boolean = false,
) => {
  const vsCodeVersion = globalState.vsCodeVersion

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const copilotHeaders = (account: Account, vision: boolean = false) => {
  const token = getCopilotToken(account)

  return copilotHeadersForToken(token, vision)
}

/**
 * Connection 原生版本的 copilotHeaders:token 直接从 credential.value 读取。
 */
export const copilotHeadersForConnection = (
  connection: ProviderConnection,
  vision: boolean = false,
) => {
  const token = getConnectionCopilotToken(connection)
  return copilotHeadersForToken(token, vision)
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubApiHeaders = () => ({
  ...standardHeaders(),
  "editor-version": `vscode/${globalState.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
