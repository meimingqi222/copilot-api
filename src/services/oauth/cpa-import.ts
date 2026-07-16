import { randomUUID } from "node:crypto"

import type { Account, OAuthAccount } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { cancelTokenRefreshTimer } from "~/lib/account-store"
import { addAccount } from "~/lib/accounts"
import { removeProviderConnection } from "~/lib/provider-connections"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { cancelOAuthRefreshTimer } from "~/services/oauth/refresh-scheduler"
import { XAI_DEFAULT_TOKEN_ENDPOINT } from "~/services/oauth/xai"

import type { CpaAuthRecord, CpaImportResult } from "./types"

import { normalizeCpaProviderType } from "./normalize"
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

function removeDuplicateAccount(
  accounts: Array<Account>,
  label: string,
  provider: OAuthProviderId,
): void {
  const duplicateIndex = accounts.findIndex(
    (item) => item.label === label && item.provider === provider,
  )
  if (duplicateIndex === -1) {
    return
  }

  const existing = accounts[duplicateIndex]
  cancelTokenRefreshTimer(existing.id)
  cancelOAuthRefreshTimer(existing.id)
  clearAccountRateLimitState(existing.id)
  removeProviderConnection(existing.id)
  accounts.splice(duplicateIndex, 1)
}

export function mapCpaRecordToAccount(
  record: CpaAuthRecord,
  options?: { label?: string; index?: number },
): OAuthAccount {
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
  const tokenEndpoint =
    provider === "xai" ?
      pickString(
        record.token_endpoint,
        record.attributes?.token_endpoint,
        record.attributes?.tokenEndpoint,
        XAI_DEFAULT_TOKEN_ENDPOINT,
      )
    : undefined

  return {
    id: randomUUID(),
    label,
    provider,
    enabled: record.disabled !== true,
    priority: 0,
    quotaState: "unknown",
    createdAt: Date.now(),
    credentials: {
      accessToken,
      refreshToken: extractRefreshToken(record),
      idToken: extractIdToken(record),
      expiresAt: parseExpiresAt(record.expired),
      accountId: pickString(record.account_id),
      projectId: pickString(record.project_id),
      deviceId: pickString(record.device_id),
      apiKey: pickString(record.api_key, record.attributes?.api_key),
      email: pickString(record.email),
    },
    settings: {
      baseUrl: pickString(record.attributes?.base_url),
      proxyUrl: pickString(record.proxy_url, record.attributes?.proxy_url),
      modelPrefix: pickString(record.prefix, record.attributes?.prefix),
      cpaSourcePath: pickString(record.attributes?.path),
      tokenEndpoint,
    },
    runtimeState: {
      authStatus: "ready",
      lastRefreshAt: parseExpiresAt(record.last_refresh),
    },
    cpaMetadata: sanitizeCpaMetadata(record),
  }
}

export function importCpaAuthRecords(
  records: Array<CpaAuthRecord>,
  options?: {
    overwrite?: boolean
    existingAccounts?: Array<Account>
    onAccount?: (account: OAuthAccount) => void
  },
): CpaImportResult {
  const result: CpaImportResult = {
    imported: [],
    skipped: [],
    failed: [],
  }

  const existing = options?.existingAccounts ?? []

  for (const [index, record] of records.entries()) {
    try {
      const account = mapCpaRecordToAccount(record, { index })
      const duplicate = existing.find(
        (item) =>
          item.label === account.label && item.provider === account.provider,
      )

      if (duplicate && !options?.overwrite) {
        result.skipped.push(account.label)
        continue
      }

      if (duplicate && options?.overwrite) {
        removeDuplicateAccount(existing, account.label, account.provider)
      }

      addAccount(account)
      existing.push(account)
      options?.onAccount?.(account)
      result.imported.push(account.label)
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
