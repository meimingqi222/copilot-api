import type { Account, AccountModel } from "~/lib/legacy-accounts"
import type { ProviderConnection } from "~/lib/provider-connections"

import {
  canonicalNativeModelId,
  getOAuthAccountId,
  isOAuthAccount,
} from "~/lib/legacy-accounts"
import {
  getConnectionProvider,
  getConnectionSettings,
  getMutableProviderConnection,
} from "~/lib/provider-connections"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"

import { buildCodexHeaders } from "./headers"

interface CodexModelPayload {
  slug?: string
  id?: string
  model?: string
  name?: string
  display_name?: string
  displayName?: string
}

function parseCodexModelId(entry: CodexModelPayload): string | undefined {
  const candidate = entry.slug ?? entry.id ?? entry.model
  if (typeof candidate !== "string" || !candidate.trim()) {
    return undefined
  }
  return canonicalNativeModelId(candidate.trim())
}

export async function getCodexModelsForAccount(
  account: Account,
  signal?: AbortSignal,
): Promise<Array<AccountModel>> {
  if (!isOAuthAccount(account) || account.provider !== "codex") {
    return []
  }

  const accessToken = account.credentials?.accessToken
  if (!accessToken) {
    return []
  }

  const baseUrl = account.settings?.baseUrl ?? CODEX_API_BASE_URL
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/models`)
  // Upstream filters models by client_version. 0.135.0 omits gpt-5.6-*;
  // 0.144.1 matches CPA fetch_codex_models and returns the current catalog.
  url.searchParams.set("client_version", "0.144.1")

  const connection = getMutableProviderConnection(account.id)
  if (!connection) {
    return []
  }
  const response = await executeUpstreamProxyCall(connection, {
    method: "GET",
    url: url.toString(),
    headers: buildCodexHeaders(accessToken, undefined, {
      accountId: getOAuthAccountId(account),
    }),
    signal,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Codex models request failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
    )
  }

  let payload: { models?: Array<CodexModelPayload> }
  try {
    payload = JSON.parse(response.body) as { models?: Array<CodexModelPayload> }
  } catch {
    throw new Error("Codex models response was not valid JSON")
  }

  const seen = new Set<string>()
  const models: Array<AccountModel> = []
  for (const entry of payload.models ?? []) {
    const id = parseCodexModelId(entry)
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    models.push({
      id,
      name: entry.display_name ?? entry.displayName ?? entry.name ?? id,
      vendor: "openai",
      pickerEnabled: true,
      supportedEndpoints: ["/v1/responses"],
      provider: "codex",
    })
  }

  if (models.length === 0) {
    throw new Error("Codex models response did not include any models")
  }

  return models
}

/**
 * Connection 原生版本:直接从 ProviderConnection 发现 codex 模型。
 * Phase 2d:消除 connectionToAccount 依赖。
 */
export async function getCodexModelsForConnection(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<AccountModel>> {
  const provider = getConnectionProvider(connection)
  if (provider !== "codex") return []

  const cred = connection.credentials[0]
  const accessToken = cred?.value
  if (!accessToken) return []

  const settings = getConnectionSettings(connection)
  const baseUrl =
    (typeof settings?.baseUrl === "string" ? settings.baseUrl : undefined)
    ?? CODEX_API_BASE_URL
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/models`)
  url.searchParams.set("client_version", "0.144.1")

  const response = await executeUpstreamProxyCall(connection, {
    method: "GET",
    url: url.toString(),
    headers: buildCodexHeaders(accessToken, undefined, {
      accountId:
        typeof cred.context?.oauthAccountId === "string" ?
          cred.context.oauthAccountId
        : undefined,
    }),
    signal,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Codex models request failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
    )
  }

  let payload: { models?: Array<CodexModelPayload> }
  try {
    payload = JSON.parse(response.body) as { models?: Array<CodexModelPayload> }
  } catch {
    throw new Error("Codex models response was not valid JSON")
  }

  const seen = new Set<string>()
  const models: Array<AccountModel> = []
  for (const entry of payload.models ?? []) {
    const id = parseCodexModelId(entry)
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    models.push({
      id,
      name: entry.display_name ?? entry.displayName ?? entry.name ?? id,
      vendor: "openai",
      pickerEnabled: true,
      supportedEndpoints: ["/v1/responses"],
      provider: "codex",
    })
  }

  if (models.length === 0) {
    throw new Error("Codex models response did not include any models")
  }

  return models
}
