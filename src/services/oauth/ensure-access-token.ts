import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { isOAuthProviderId } from "~/lib/provider-config"
import {
  getConnectionProvider,
  getMutableProviderConnection,
} from "~/lib/provider-connections"

import { extractJwtExpiryMs } from "./jwt"
import { refreshOAuthConnectionToken } from "./refresh-scheduler"

const EXPIRY_SKEW_MS = 60_000
// Claude mirrors the official Claude Code CLI, which refreshes ~5 minutes
// before expiry to avoid sending a borderline-expired token (a 401 mid-stream
// is costly). Other OAuth providers keep the tighter 60s skew.
const CLAUDE_EXPIRY_SKEW_MS = 5 * 60_000

interface EnsureOAuthAccessTokenOptions {
  forceRefresh?: boolean
  failedAccessToken?: string
}

/**
 * ensureOAuthConnectionAccessToken 的读取辅助:credential.value 即
 * OAuth access token 的运行时真相(context.accessToken 为迁移时的镜像)。
 */
function connectionAccessToken(credential: ApiCredential): string | undefined {
  return credential.value || undefined
}

function connectionRefreshToken(credential: ApiCredential): string | undefined {
  const token = credential.context?.refreshToken
  return typeof token === "string" && token ? token : undefined
}

function connectionTokenExpiry(credential: ApiCredential): number | undefined {
  const expiry = credential.context?.expiresAt
  if (typeof expiry === "number") return expiry
  // CPA also falls back to the JWT exp claim. This is essential for imported
  // Codex credentials whose auth file contains tokens but no `expired` field.
  return extractJwtExpiryMs(credential.value)
}

function connectionExpirySkewMs(connection: ProviderConnection): number {
  return getConnectionProvider(connection) === "claude" ?
      CLAUDE_EXPIRY_SKEW_MS
    : EXPIRY_SKEW_MS
}

/** 刷新后从 stateRoot 中的 live connection 重新读取 access token。 */
function readLiveAccessToken(connectionId: string): string | undefined {
  const conn = getMutableProviderConnection(connectionId)
  const cred = conn?.credentials[0]
  return cred ? connectionAccessToken(cred) : undefined
}

/**
 * ensureOAuthAccessToken 的 connection 原生等价物。
 *
 * 读取路径纯 credential:value = access token、context.refreshToken /
 * expiresAt 为刷新材料。刷新路径调用 refreshOAuthConnectionToken(同样是
 * connection 原生),刷新后从 live connection 重读 token,不依赖传入
 * credential 对象的同一性。
 *
 * 非 OAuth connection(或尚未具备 legacy metadata 的 connection)直接
 * 返回 credential.value,不触发刷新。
 */
export async function ensureOAuthConnectionAccessToken(
  connection: ProviderConnection,
  credential: ApiCredential,
  options: EnsureOAuthAccessTokenOptions = {},
): Promise<string | undefined> {
  // Admission and long-lived callers may hold snapshots. Always make refresh
  // decisions from the latest state so a concurrent refresh is not mistaken
  // for the token that just failed upstream.
  const liveConnection = getMutableProviderConnection(connection.id)
  const effectiveConnection = liveConnection ?? connection
  const effectiveCredential =
    effectiveConnection.credentials.find((item) => item.id === credential.id)
    ?? credential

  const provider = getConnectionProvider(effectiveConnection)
  if (!provider || !isOAuthProviderId(provider)) {
    return connectionAccessToken(effectiveCredential)
  }

  const currentToken = connectionAccessToken(effectiveCredential)
  if (
    options.forceRefresh
    && options.failedAccessToken
    && currentToken
    && currentToken !== options.failedAccessToken
  ) {
    return currentToken
  }

  const refreshToken = connectionRefreshToken(effectiveCredential)
  const expiresAt = connectionTokenExpiry(effectiveCredential)
  const needsRefresh =
    !currentToken
    || (refreshToken !== undefined
      && expiresAt !== undefined
      && expiresAt <= Date.now() + connectionExpirySkewMs(effectiveConnection))
  if (!options.forceRefresh && !needsRefresh) {
    return currentToken
  }

  // 无 refresh token 则无法刷新(镜像 tokenNeedsRefresh 的门禁)。
  if (!refreshToken) {
    return currentToken
  }

  // 刷新必须落在 stateRoot 中的 live connection 上(传入对象可能是快照)。
  if (!liveConnection) {
    return currentToken
  }

  await refreshOAuthConnectionToken(
    liveConnection,
    options.forceRefresh ? "unauthorized" : "pre-request",
  )
  return readLiveAccessToken(connection.id) ?? currentToken
}
