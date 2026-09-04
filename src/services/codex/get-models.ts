import type { Account, AccountModel } from "~/lib/legacy-accounts"
import type { ProviderConnection } from "~/lib/provider-connections"

import {
  canonicalNativeModelId,
  getOAuthAccountId,
  isOAuthAccount,
} from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import {
  getConnectionProvider,
  getConnectionProxyUrl,
  getConnectionSettings,
  getMutableProviderConnection,
} from "~/lib/provider-connections"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"
import { oauthFetch } from "~/services/oauth/fetch"

import { buildCodexHeaders, CODEX_CLIENT_VERSION } from "./headers"

interface CodexModelPayload {
  slug?: string
  id?: string
  model?: string
  name?: string
  display_name?: string
  displayName?: string
}

// CPA-maintained mirror of the Codex client model catalog. This catalog is
// fetched offline by CPA's fetch_codex_models tool using a real account and
// published here, so it can include models that the upstream /models endpoint
// has not yet listed publicly (e.g. gpt-6-astra). Public, no auth required.
const CODEX_CATALOG_MIRROR_URLS = [
  "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/codex_client_models.json",
  "https://models.router-for.me/codex_client_models.json",
]

function parseCodexModelId(entry: CodexModelPayload): string | undefined {
  const candidate = entry.slug ?? entry.id ?? entry.model
  if (typeof candidate !== "string" || !candidate.trim()) {
    return undefined
  }
  return canonicalNativeModelId(candidate.trim())
}

function parseCodexModelsPayload(raw: string): Array<AccountModel> {
  let payload: { models?: Array<CodexModelPayload> }
  try {
    payload = JSON.parse(raw) as { models?: Array<CodexModelPayload> }
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
 * Fetch the Codex client model catalog from the CPA-maintained mirror.
 * This catalog can include models not yet listed by the upstream /models
 * endpoint (e.g. gpt-6-astra). No auth required; respects the connection
 * proxy so it works behind firewalls.
 */
async function fetchCodexModelsFromMirror(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<AccountModel> | undefined> {
  const proxyUrl = getConnectionProxyUrl(connection)
  for (const url of CODEX_CATALOG_MIRROR_URLS) {
    try {
      const response = await oauthFetch(
        url,
        { method: "GET", signal },
        { proxyUrl },
      )
      if (!response.ok) {
        logger.debug(
          `Codex catalog mirror fetch returned ${response.status} from ${url}`,
        )
        continue
      }
      const body = await response.text()
      return parseCodexModelsPayload(body)
    } catch (error) {
      logger.debug(
        `Codex catalog mirror fetch failed from ${url}: ${(error as Error).message}`,
      )
    }
  }
  return undefined
}

async function fetchCodexModelsFromUpstream(
  connection: ProviderConnection,
  accessToken: string,
  baseUrl: string,
  accountId?: string,
  signal?: AbortSignal,
): Promise<Array<AccountModel>> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/models`)
  // Upstream filters models by client_version. 0.135.0 omits gpt-5.6-*;
  // 0.153.3 matches CPA fetch_codex_models and returns the current catalog
  // (incl. gpt-6-astra, which requires minimal_client_version >= 0.153.0).
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION)

  const response = await executeUpstreamProxyCall(connection, {
    method: "GET",
    url: url.toString(),
    headers: buildCodexHeaders(accessToken, undefined, { accountId }),
    signal,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Codex models request failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
    )
  }

  return parseCodexModelsPayload(response.body)
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

  const connection = getMutableProviderConnection(account.id)
  if (!connection) {
    return []
  }

  // Prefer the CPA mirror catalog (more complete, includes pre-release models
  // like gpt-6-astra). Fall back to the upstream /models endpoint.
  const mirrored = await fetchCodexModelsFromMirror(connection, signal)
  if (mirrored) {
    logger.debug(
      `Codex models for "${account.label}" sourced from CPA mirror (${mirrored.length} models)`,
    )
    return mirrored
  }

  const baseUrl = account.settings?.baseUrl ?? CODEX_API_BASE_URL
  return fetchCodexModelsFromUpstream(
    connection,
    accessToken,
    baseUrl,
    getOAuthAccountId(account),
    signal,
  )
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

  // Prefer the CPA mirror catalog (more complete, includes pre-release models
  // like gpt-6-astra). Fall back to the upstream /models endpoint.
  const mirrored = await fetchCodexModelsFromMirror(connection, signal)
  if (mirrored) {
    logger.debug(
      `Codex models for "${connection.name}" sourced from CPA mirror (${mirrored.length} models)`,
    )
    return mirrored
  }

  const settings = getConnectionSettings(connection)
  const baseUrl =
    (typeof settings?.baseUrl === "string" ? settings.baseUrl : undefined)
    ?? CODEX_API_BASE_URL
  return fetchCodexModelsFromUpstream(
    connection,
    accessToken,
    baseUrl,
    typeof cred.context?.oauthAccountId === "string" ?
      cred.context.oauthAccountId
    : undefined,
    signal,
  )
}
