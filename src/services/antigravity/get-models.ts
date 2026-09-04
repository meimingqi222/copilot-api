import type { Account, AccountModel } from "~/lib/legacy-accounts"
import type { ProviderConnection } from "~/lib/provider-connections"

import {
  canonicalNativeModelId,
  getOAuthProjectId,
  isOAuthAccount,
} from "~/lib/legacy-accounts"
import {
  getConnectionProvider,
  getMutableProviderConnection,
} from "~/lib/provider-connections"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"
import {
  ANTIGRAVITY_API_BASE_URL,
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_DAILY_API_BASE_URL,
} from "~/services/oauth/antigravity"

import { buildAntigravityHeaders } from "./headers"

// Daily first, matching CPA (daily gets new models like gemini-3.8-flash
// before the prod endpoint rolls them out).
const ANTIGRAVITY_MODEL_BASE_URLS = [
  ANTIGRAVITY_DAILY_API_BASE_URL,
  ANTIGRAVITY_API_BASE_URL,
]

const SKIPPED_ANTIGRAVITY_MODELS = new Set([
  "chat_20706",
  "chat_23310",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
  "gemini-2.5-flash-thinking",
  "gemini-2.5-pro",
])

interface AntigravityModelNode {
  displayName?: string
  maxTokens?: number | string
  maxOutputTokens?: number | string
}

function parseAntigravityModelsPayload(body: string): Array<AccountModel> {
  let payload: { models?: Record<string, AntigravityModelNode> }
  try {
    payload = JSON.parse(body) as {
      models?: Record<string, AntigravityModelNode>
    }
  } catch {
    throw new Error("Antigravity models response was not valid JSON")
  }

  const models: Array<AccountModel> = []
  for (const [rawId, node] of Object.entries(payload.models ?? {})) {
    const id = canonicalNativeModelId(rawId.trim())
    if (!id || SKIPPED_ANTIGRAVITY_MODELS.has(id)) {
      continue
    }
    models.push({
      id,
      name: node.displayName?.trim() || id,
      vendor: "antigravity",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions", "/v1/messages"],
      provider: "antigravity",
    })
  }

  return models
}

export async function getAntigravityModelsForAccount(
  account: Account,
  signal?: AbortSignal,
): Promise<Array<AccountModel>> {
  if (!isOAuthAccount(account) || account.provider !== "antigravity") {
    return []
  }

  const accessToken = account.credentials?.accessToken
  if (!accessToken) {
    return []
  }

  const projectId = getOAuthProjectId(account)
  const requestBody = JSON.stringify(projectId ? { project: projectId } : {})
  let lastError = "Antigravity models request failed"

  const connection = getMutableProviderConnection(account.id)
  if (!connection) {
    return []
  }

  for (const baseUrl of ANTIGRAVITY_MODEL_BASE_URLS) {
    const response = await executeUpstreamProxyCall(connection, {
      method: "POST",
      url: `${baseUrl}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`,
      headers: buildAntigravityHeaders(accessToken),
      body: requestBody,
      signal,
    })

    if (response.statusCode < 200 || response.statusCode >= 300) {
      lastError = `Antigravity models request failed (${response.statusCode}): ${response.body.slice(0, 200)}`
      continue
    }

    const models = parseAntigravityModelsPayload(response.body)
    if (models.length === 0) {
      lastError = "Antigravity models response did not include any models"
      continue
    }

    return models
  }

  throw new Error(lastError)
}

/**
 * Connection 原生版本:直接从 ProviderConnection 发现 antigravity 模型。
 * Phase 2d:消除 connectionToAccount 依赖。
 */
export async function getAntigravityModelsForConnection(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<AccountModel>> {
  const provider = getConnectionProvider(connection)
  if (provider !== "antigravity") return []

  const cred = connection.credentials[0]
  const accessToken = cred?.value
  if (!accessToken) return []

  const projectId =
    typeof cred.context?.projectId === "string" ?
      cred.context.projectId
    : undefined
  const requestBody = JSON.stringify(projectId ? { project: projectId } : {})
  let lastError = "Antigravity models request failed"

  for (const baseUrl of ANTIGRAVITY_MODEL_BASE_URLS) {
    const response = await executeUpstreamProxyCall(connection, {
      method: "POST",
      url: `${baseUrl}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`,
      headers: buildAntigravityHeaders(accessToken),
      body: requestBody,
      signal,
    })

    if (response.statusCode < 200 || response.statusCode >= 300) {
      lastError = `Antigravity models request failed (${response.statusCode}): ${response.body.slice(0, 200)}`
      continue
    }

    const models = parseAntigravityModelsPayload(response.body)
    if (models.length === 0) {
      lastError = "Antigravity models response did not include any models"
      continue
    }

    return models
  }

  throw new Error(lastError)
}
