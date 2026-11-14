import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { getConnectionProvider } from "~/lib/provider-connections"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"
import {
  ANTIGRAVITY_API_BASE_URL,
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_DAILY_API_BASE_URL,
} from "~/services/oauth/antigravity"

import { buildAntigravityHeaders } from "./headers"
import {
  collapseAntigravityModelVariants,
  type RawAntigravityCatalogEntry,
} from "./variant-collapse"

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

export function parseAntigravityModelsPayload(
  body: string,
): Array<ModelMapping> {
  let payload: { models?: Record<string, AntigravityModelNode> }
  try {
    payload = JSON.parse(body) as {
      models?: Record<string, AntigravityModelNode>
    }
  } catch {
    throw new Error("Antigravity models response was not valid JSON")
  }

  const entries: Array<RawAntigravityCatalogEntry> = []
  for (const [rawId, node] of Object.entries(payload.models ?? {})) {
    const id = canonicalNativeModelId(rawId.trim())
    if (!id || SKIPPED_ANTIGRAVITY_MODELS.has(id)) {
      continue
    }
    entries.push({
      publicId: id,
      name: node.displayName?.trim() || id,
      endpoints: ["chat", "messages"],
    })
  }

  // Effort-suffixed SKUs (gemini-4-hydrogen-low/…) fold into one family head;
  // clients pick the tier with reasoning_effort at dispatch.
  return collapseAntigravityModelVariants(entries)
}

/**
 * POST `fetchAvailableModels` (daily first) and return the first successful
 * body. Model discovery and the per-model quota both read this reply.
 */
export async function requestAntigravityAvailableModels(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const cred = connection.credentials[0]
  const accessToken = cred?.value
  if (!accessToken) return undefined

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
    if (parseAntigravityModelsPayload(response.body).length === 0) {
      lastError = "Antigravity models response did not include any models"
      continue
    }
    return response.body
  }

  throw new Error(lastError)
}

/**
 * Connection 原生版本:直接从 ProviderConnection 发现 antigravity 模型。
 * Effort variants are already collapsed into family heads + hidden pins.
 */
export async function getAntigravityModelsForConnection(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<ModelMapping>> {
  if (getConnectionProvider(connection) !== "antigravity") return []
  const body = await requestAntigravityAvailableModels(connection, signal)
  return body ? parseAntigravityModelsPayload(body) : []
}
