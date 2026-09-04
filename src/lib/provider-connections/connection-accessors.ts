/**
 * Connection 原生的凭据访问器(替代 accounts.ts 中的 Account 级访问器)。
 *
 * Phase 5:Account 运行时模型消除后,上层代码通过这些函数直接从
 * ProviderConnection/ApiCredential 读取凭据,不再经由 connectionToAccount
 * 派生 Account 快照。
 *
 * Token 位置速查:
 * - copilot token(credential.value)、githubToken(context.githubToken)
 * - codebuff authToken(credential.value)
 * - windsurf apiKey(credential.value)
 * - mimo serviceToken(credential.value)、xiaomichatbotPh(credentialExtras)
 * - OAuth access(credential.value)、refreshToken/context 字段(credential.context)
 */

import { isOAuthProviderId } from "~/lib/provider-config"

import type { ProviderConnection } from "./types"

import { getConnectionProvider } from "./connection-metadata"
import {
  getCredentialContextString,
  getCredentialExtraString,
} from "./connection-metadata"

/** 读取 credential.value(所有 provider 的 primary token 都存这里)。 */
export function getCredentialValue(
  conn: ProviderConnection,
): string | undefined {
  const value = conn.credentials[0]?.value
  return typeof value === "string" && value ? value : undefined
}

/** 读取 credential.value,允许返回空字符串(用于 admin 更新清空场景)。 */
export function getCredentialValueRaw(
  conn: ProviderConnection,
): string | undefined {
  const value = conn.credentials[0]?.value
  return typeof value === "string" ? value : undefined
}

// ── Provider-specific 凭据访问器 ──────────────────────────────

/** Copilot githubToken(刷新源材料,存于 credential.context)。 */
export function getConnectionGithubToken(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialContextString(conn, "githubToken")
}

/** Copilot token(JWT,存于 credential.value)。 */
export function getConnectionCopilotToken(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialValue(conn)
}

/** Codebuff authToken(存于 credential.value)。 */
export function getConnectionCodebuffAuthToken(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialValue(conn)
}

/** Windsurf apiKey(存于 credential.value)。 */
export function getConnectionWindsurfApiKey(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialValue(conn)
}

/** Mimo serviceToken(存于 credential.value)。 */
export function getConnectionMimoServiceToken(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialValue(conn)
}

/** Mimo xiaomichatbotPh(存于 credentialExtras)。 */
export function getConnectionMimoPh(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialExtraString(conn, "xiaomichatbotPh")
}

/** Mimo mimoWsToken(存于 credentialExtras)。 */
export function getConnectionMimoWsToken(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialExtraString(conn, "mimoWsToken")
}

/** OAuth accessToken(存于 credential.value)。 */
export function getConnectionOAuthAccessToken(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialValue(conn)
}

/** OAuth refreshToken(存于 credential.context)。 */
export function getConnectionOAuthRefreshToken(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialContextString(conn, "refreshToken")
}

/** OAuth apiKey(存于 credential.context)。 */
export function getConnectionOAuthApiKey(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialContextString(conn, "apiKey")
}

/** OAuth accountId(存于 credential.context,键名 oauthAccountId)。 */
export function getConnectionOAuthAccountId(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialContextString(conn, "oauthAccountId")
}

/** OAuth projectId(存于 credential.context)。 */
export function getConnectionOAuthProjectId(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialContextString(conn, "projectId")
}

/** OAuth deviceId(存于 credential.context)。 */
export function getConnectionOAuthDeviceId(
  conn: ProviderConnection,
): string | undefined {
  return getCredentialContextString(conn, "deviceId")
}

// ── 类型守卫 ─────────────────────────────────────────────────

/** 判断 connection 是否为 OAuth provider(替代 isOAuthAccount)。 */
export function isOAuthConnection(conn: ProviderConnection): boolean {
  const provider = getConnectionProvider(conn)
  return provider !== undefined && isOAuthProviderId(provider)
}

/** 判断 connection 是否有凭据(替代 getHasCredentials)。 */
export function connectionHasCredentials(conn: ProviderConnection): boolean {
  const provider = getConnectionProvider(conn)
  if (provider === "copilot") {
    return Boolean(getConnectionGithubToken(conn))
  }
  if (provider === "codebuff") {
    return Boolean(getConnectionCodebuffAuthToken(conn))
  }
  if (provider === "windsurf") {
    return Boolean(getConnectionWindsurfApiKey(conn))
  }
  if (provider !== undefined && isOAuthProviderId(provider)) {
    return Boolean(
      getConnectionOAuthAccessToken(conn) || getConnectionOAuthApiKey(conn),
    )
  }
  return Boolean(
    getConnectionMimoServiceToken(conn) && getConnectionMimoPh(conn),
  )
}
