import type { Account, AccountModel } from "~/lib/accounts"

import {
  canonicalNativeModelId,
  getOAuthProjectId,
  isOAuthAccount,
} from "~/lib/accounts"
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

  for (const baseUrl of ANTIGRAVITY_MODEL_BASE_URLS) {
    const response = await executeUpstreamProxyCall(account, {
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
