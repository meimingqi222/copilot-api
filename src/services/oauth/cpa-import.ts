import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import { cancelTokenRefreshTimer } from "~/lib/account-store"
import {
  providerFromProtocol,
  removeProviderConnection,
  setConnectionSetting,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { cancelOAuthRefreshTimer } from "~/services/oauth/refresh-scheduler"
import { XAI_DEFAULT_TOKEN_ENDPOINT } from "~/services/oauth/xai"

import type { CpaAuthRecord, CpaImportResult } from "./types"

import {
  applyOAuthBundleToCredential,
  applyOAuthConnectionSettings,
} from "./apply-bundle"
import { normalizeCpaProviderType } from "./normalize"
import { createOAuthConnection } from "./provider-strategies"
import { parseExpiresAt } from "./token-resolver"

function pickString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function extractAccessToken(record: CpaAuthRecord): string | undefined {
  return pickString(
    record.access_token,
    record.token?.access_token,
    record.metadata?.access_token,
    record.attributes?.api_key,
    record.api_key,
  )
}

function extractRefreshToken(record: CpaAuthRecord): string | undefined {
  return pickString(record.refresh_token, record.token?.refresh_token)
}

function extractIdToken(record: CpaAuthRecord): string | undefined {
  return pickString(record.id_token, record.token?.id_token)
}

function sanitizeCpaMetadata(
  record: CpaAuthRecord,
): Record<string, unknown> | undefined {
  const {
    access_token: _accessToken,
    refresh_token: _refreshToken,
    id_token: _idToken,
    api_key: _apiKey,
    token: _token,
    ...rest
  } = record
  return Object.keys(rest).length > 0 ? rest : undefined
}

function buildLabel(
  record: CpaAuthRecord,
  provider: OAuthProviderId,
  index: number,
): string {
  return (
    pickString(record.label, record.email, record.project_id, record.account_id)
    ?? `${provider}-${index + 1}`
  )
}

function removeDuplicateConnection(
  connections: Array<ProviderConnection>,
  label: string,
  provider: OAuthProviderId,
): void {
  const duplicateIndex = connections.findIndex(
    (conn) =>
      conn.name === label && providerFromProtocol(conn.protocol) === provider,
  )
  if (duplicateIndex === -1) {
    return
  }

  const existing = connections[duplicateIndex]
  cancelTokenRefreshTimer(existing.id)
  cancelOAuthRefreshTimer(existing.id)
  clearAccountRateLimitState(existing.id)
  removeProviderConnection(existing.id)
  connections.splice(duplicateIndex, 1)
}

/**
 * Phase 3:直接从 CPA auth record 创建 ProviderConnection,
 * 不再经过 OAuthAccount 中转。
 */
export function mapCpaRecordToConnection(
  record: CpaAuthRecord,
  options?: { label?: string; index?: number },
): ProviderConnection {
  const provider = normalizeCpaProviderType(record.type)
  if (!provider) {
    throw new Error(`Unsupported CPA auth type: ${String(record.type)}`)
  }

  const accessToken = extractAccessToken(record)
  if (!accessToken) {
    throw new Error("CPA auth record is missing access_token or api_key")
  }

  const index = options?.index ?? 0
  const label = options?.label ?? buildLabel(record, provider, index)

  // 创建 connection(同步,不持久化)
  const conn = createOAuthConnection(provider, label)
  conn.enabled = record.disabled !== true

  // 应用 OAuth bundle(accessToken/refreshToken/expiresAt/context)
  applyOAuthBundleToCredential(
    conn,
    {
      accessToken,
      refreshToken: extractRefreshToken(record),
      expiresAt: parseExpiresAt(record.expired),
    },
    {
      idToken: extractIdToken(record),
      accountId: pickString(record.account_id),
      projectId: pickString(record.project_id),
      deviceId: pickString(record.device_id),
      apiKey: pickString(record.api_key, record.attributes?.api_key),
      email: pickString(record.email),
    },
  )

  // 应用 settings(baseUrl/proxyUrl/tokenEndpoint 等)
  const tokenEndpoint =
    provider === "xai" ?
      pickString(
        record.token_endpoint,
        record.attributes?.token_endpoint,
        record.attributes?.tokenEndpoint,
        XAI_DEFAULT_TOKEN_ENDPOINT,
      )
    : undefined

  applyOAuthConnectionSettings(conn, {
    baseUrl: pickString(record.attributes?.base_url),
    tokenEndpoint,
  })

  // proxyUrl / modelPrefix / cpaSourcePath 写入 metadata.settings
  // (connectionToAccount 从 metadata.settings 恢复 account.settings)
  const proxyUrl = pickString(record.proxy_url, record.attributes?.proxy_url)
  if (proxyUrl) {
    setConnectionSetting(conn, "proxyUrl", proxyUrl)
    conn.proxyUrl = proxyUrl
  }
  const modelPrefix = pickString(record.prefix, record.attributes?.prefix)
  if (modelPrefix) {
    setConnectionSetting(conn, "modelPrefix", modelPrefix)
    conn.modelPrefix = modelPrefix
  }
  const cpaSourcePath = pickString(record.attributes?.path)
  if (cpaSourcePath) {
    setConnectionSetting(conn, "cpaSourcePath", cpaSourcePath)
  }

  // cpaMetadata 存入 connection.metadata.cpaMetadata
  const cpaMeta = sanitizeCpaMetadata(record)
  if (cpaMeta) {
    conn.metadata = { ...conn.metadata, cpaMetadata: cpaMeta }
  }

  // lastRefreshAt 存入 metadata
  const lastRefreshAt = parseExpiresAt(record.last_refresh)
  if (lastRefreshAt !== undefined) {
    conn.metadata = { ...conn.metadata, lastRefreshAt }
  }

  return conn
}

export function importCpaAuthRecords(
  records: Array<CpaAuthRecord>,
  options?: {
    overwrite?: boolean
    /** 重复检测用的已有 connection 列表。 */
    existingConnections?: Array<ProviderConnection>
    /** 回调接收 ProviderConnection。 */
    onAccount?: (connection: ProviderConnection) => void
    onConnection?: (connection: ProviderConnection) => void
  },
): CpaImportResult {
  const result: CpaImportResult = {
    imported: [],
    skipped: [],
    failed: [],
  }

  // 优先使用 existingConnections;若调用方仍传 existingAccounts,
  // 从 listProviderConnections() 派生 connection 列表用于重复检测
  const existing = options?.existingConnections ?? []

  for (const [index, record] of records.entries()) {
    try {
      const conn = mapCpaRecordToConnection(record, { index })
      const label = conn.name
      // 从 protocol 反推 provider id 用于重复检测
      const providerId = normalizeCpaProviderType(record.type)

      // 检查重复(通过 label + provider 匹配)
      const duplicate = existing.find(
        (item) =>
          item.name === label
          && providerFromProtocol(item.protocol) === providerId,
      )

      if (duplicate && !options?.overwrite) {
        result.skipped.push(label)
        continue
      }

      if (duplicate && options?.overwrite && providerId) {
        removeDuplicateConnection(existing, label, providerId)
      }

      // 直接 upsert ProviderConnection
      upsertProviderConnection(conn)
      existing.push(conn)

      // onAccount/onConnection 回调接收 ProviderConnection
      options?.onAccount?.(conn)
      options?.onConnection?.(conn)
      result.imported.push(label)
    } catch (error) {
      const label =
        pickString(record.label, record.email) ?? `record-${index + 1}`
      result.failed.push({
        label,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}

export function parseCpaAuthPayload(payload: unknown): Array<CpaAuthRecord> {
  if (Array.isArray(payload)) {
    return payload as Array<CpaAuthRecord>
  }

  if (payload && typeof payload === "object") {
    const objectPayload = payload as Record<string, unknown>
    if (Array.isArray(objectPayload.accounts)) {
      return objectPayload.accounts as Array<CpaAuthRecord>
    }
    if (Array.isArray(objectPayload.auths)) {
      return objectPayload.auths as Array<CpaAuthRecord>
    }
    return [objectPayload as CpaAuthRecord]
  }

  throw new Error("CPA import payload must be an object or array")
}
