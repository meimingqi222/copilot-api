import { randomUUID } from "node:crypto"

import type { State } from "./state"

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

export const copilotHeaders = (state: State, vision: boolean = false) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
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

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
