import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import {
  getCredentialContextString,
  getConnectionRedirectUri,
  setCredentialContextField,
} from "~/lib/provider-connections"

import type { OAuthFetchOptions } from "./fetch"

import {
  ANTIGRAVITY_REDIRECT_URI,
  applyAntigravityOAuthBundle,
  refreshAntigravityTokens,
} from "./antigravity"
import { applyClaudeOAuthBundle, refreshClaudeTokens } from "./claude"
import { applyCodexOAuthBundle, refreshCodexTokens } from "./codex"
import {
  applyKimiOAuthBundle,
  createKimiDeviceId,
  refreshKimiTokens,
} from "./kimi"
import {
  applyXaiOAuthBundle,
  getXaiTokenEndpoint,
  refreshXaiTokens,
} from "./xai"

export type OAuthRefreshFn = (
  connection: ProviderConnection,
  refreshToken: string,
  fetchOptions: OAuthFetchOptions,
) => Promise<void>

/**
 * 读取 connection 上的 kimi deviceId。
 * 刷新路径写入 credential.context.deviceId;迁移路径可能仅存在于
 * credentialExtras.deviceId,两处都检查。
 */
export function getConnectionOAuthDeviceId(
  connection: ProviderConnection,
): string | undefined {
  const fromContext = getCredentialContextString(connection, "deviceId")
  if (fromContext) return fromContext
  const extras = connection.metadata?.credentialExtras as
    | Record<string, unknown>
    | undefined
  const value = extras?.deviceId
  return typeof value === "string" && value ? value : undefined
}

export const OAUTH_REFRESH_STRATEGIES: Record<OAuthProviderId, OAuthRefreshFn> =
  {
    claude: async (connection, refreshToken, fetchOptions) => {
      const bundle = await refreshClaudeTokens(refreshToken, fetchOptions)
      applyClaudeOAuthBundle(connection, bundle)
    },
    kimi: async (connection, refreshToken, fetchOptions) => {
      const existingDeviceId = getConnectionOAuthDeviceId(connection)
      const deviceId = createKimiDeviceId(existingDeviceId)
      const bundle = await refreshKimiTokens(
        refreshToken,
        deviceId,
        fetchOptions,
      )
      applyKimiOAuthBundle(connection, bundle)
      if (!existingDeviceId) {
        setCredentialContextField(connection, "deviceId", deviceId)
      }
    },
    codex: async (connection, refreshToken, fetchOptions) => {
      const bundle = await refreshCodexTokens(refreshToken, fetchOptions)
      applyCodexOAuthBundle(connection, bundle)
    },
    antigravity: async (connection, refreshToken, fetchOptions) => {
      const bundle = await refreshAntigravityTokens(refreshToken, fetchOptions)
      applyAntigravityOAuthBundle(connection, {
        ...bundle,
        redirectUri:
          getConnectionRedirectUri(connection) ?? ANTIGRAVITY_REDIRECT_URI,
      })
    },
    xai: async (connection, refreshToken, fetchOptions) => {
      const tokenEndpoint = getXaiTokenEndpoint(connection) ?? ""
      const bundle = await refreshXaiTokens(
        refreshToken,
        tokenEndpoint,
        fetchOptions,
      )
      applyXaiOAuthBundle(connection, bundle)
    },
  }

export const OAUTH_REFRESH_LEAD_MS: Partial<Record<OAuthProviderId, number>> = {
  codex: 5 * 24 * 60 * 60 * 1000,
  claude: 4 * 60 * 60 * 1000,
}
