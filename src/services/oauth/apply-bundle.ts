import type { ProviderConnection } from "~/lib/provider-connections"

import {
  ensureLegacyMetadata,
  setConnectionAuthStatus,
  setConnectionCredentialExtra,
  setConnectionSetting,
  setCredentialContextField,
  setCredentialValue,
} from "~/lib/provider-connections"

export interface OAuthBundleCore {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
}

/**
 * Provider bundle 中除 OAuthBundleCore 外的已知字段。
 * - context 字段(刷新源材料):idToken / oauthAccountId / projectId / deviceId / apiKey
 * - credentialExtras 字段(展示用):email / organizationId / organizationName
 */
export interface OAuthBundleExtras {
  idToken?: string
  accountId?: string
  projectId?: string
  deviceId?: string
  apiKey?: string
  email?: string
  organizationId?: string
  organizationName?: string
}

/** bundle 中落入 credential.context 的字段(undefined 保留旧值)。 */
const CONTEXT_KEYS = [
  "idToken",
  "accountId",
  "projectId",
  "deviceId",
  "apiKey",
] as const

/** bundle 中落入 metadata.credentialExtras 的字段(undefined 保留旧值)。 */
const EXTRA_KEYS = ["email", "organizationId", "organizationName"] as const

function readContextString(
  connection: ProviderConnection,
  key: string,
): string | undefined {
  const value = connection.credentials[0]?.context?.[key]
  return typeof value === "string" && value ? value : undefined
}

/**
 * 通用 OAuth bundle 落库(connection 原生):
 * - credential.value = accessToken
 * - credential.context:refreshToken / expiresAt / idToken / oauthAccountId /
 *   projectId / deviceId / apiKey(undefined 字段保留旧值)
 * - metadata.credentialExtras:同步镜像 context 字段 + email /
 *   organizationId / organizationName(迁移路径将 OAuth credentials 写入
 *   credentialExtras,connectionToAccount 的 extras 覆盖 context 读取,
 *   因此刷新时两处都必须更新,否则 Account 快照读到旧值)
 * - metadata.authStatus 置为 ready(等价原 runtimeState.authStatus = "ready")
 */
export function applyOAuthBundleToCredential(
  connection: ProviderConnection,
  bundle: OAuthBundleCore,
  extras?: OAuthBundleExtras,
): void {
  setCredentialValue(connection, bundle.accessToken)

  const oldRefreshToken = readContextString(connection, "refreshToken")
  const nextRefreshToken = bundle.refreshToken ?? oldRefreshToken
  if (nextRefreshToken !== undefined) {
    setCredentialContextField(connection, "refreshToken", nextRefreshToken)
    setConnectionCredentialExtra(connection, "refreshToken", nextRefreshToken)
  }
  if (bundle.expiresAt !== undefined) {
    setCredentialContextField(connection, "expiresAt", bundle.expiresAt)
    setConnectionCredentialExtra(connection, "expiresAt", bundle.expiresAt)
  }
  // accessToken 镜像(迁移约定:context.accessToken 为迁移时的镜像)
  setCredentialContextField(connection, "accessToken", bundle.accessToken)

  for (const key of CONTEXT_KEYS) {
    const value = extras?.[key]
    if (value !== undefined) {
      setCredentialContextField(
        connection,
        key === "accountId" ? "oauthAccountId" : key,
        value,
      )
      setConnectionCredentialExtra(connection, key, value)
    }
  }

  for (const key of EXTRA_KEYS) {
    const value = extras?.[key]
    if (value !== undefined) {
      setConnectionCredentialExtra(connection, key, value)
    }
  }

  setConnectionAuthStatus(connection, "ready")
}

/**
 * 写入 OAuth settings 字段(metadata.settings),并把 routing 字段
 * (tokenEndpoint / redirectUri)镜像到 metadata 顶层
 * (getConnectionTokenEndpoint / getConnectionRedirectUri 从顶层读取)。
 */
export function applyOAuthConnectionSettings(
  connection: ProviderConnection,
  settings: {
    baseUrl?: string
    tokenEndpoint?: string
    redirectUri?: string
  },
): void {
  const meta = ensureLegacyMetadata(connection)
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue
    setConnectionSetting(connection, key, value)
    if (key === "tokenEndpoint") {
      meta.tokenEndpoint = value
    } else if (key === "redirectUri") {
      meta.redirectUri = value
    }
  }
}
