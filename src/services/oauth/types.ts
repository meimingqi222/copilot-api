import type { OAuthProviderId } from "~/lib/provider-config"

import { isOAuthProviderId as isOAuthProviderIdFromConfig } from "~/lib/provider-config"

/** CPA-compatible auth JSON shape (auths/*.json). */
export interface CpaAuthRecord {
  type?: string
  access_token?: string
  refresh_token?: string
  id_token?: string
  account_id?: string
  project_id?: string
  device_id?: string
  email?: string
  label?: string
  disabled?: boolean
  expired?: string
  last_refresh?: string
  prefix?: string
  proxy_url?: string
  api_key?: string
  token?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
  }
  attributes?: Record<string, string>
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface CpaImportResult {
  imported: Array<string>
  skipped: Array<string>
  failed: Array<{ label: string; reason: string }>
}

export interface UpstreamProxyRequest {
  accountId: string
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface UpstreamProxyResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return isOAuthProviderIdFromConfig(value)
}
