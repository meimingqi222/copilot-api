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
  applyMinimaxOAuthBundle,
  refreshMinimaxTokens,
  resolveMinimaxRegion,
} from "./minimax"
import { applyQoderJobTokenRefresh, refreshQoderJobToken } from "./qoder"
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
    minimax: async (connection, refreshToken, fetchOptions) => {
      // 账号域由 connection 上的 region 决定（baseUrl 里也带着区域，
      // resolveMinimaxRegion 会在 context 缺失时从那里反查）。
      const region = resolveMinimaxRegion(connection)
      const bundle = await refreshMinimaxTokens(
        refreshToken,
        region,
        fetchOptions,
      )
      applyMinimaxOAuthBundle(connection, bundle)
    },
    // Qoder 的 refresh token 只刷 job token（chat 用）；设备 token 及其 refresh
    // 由 quota fetcher 在 401 时自行惰性轮换，不走这条调度路径。
    qoder: async (connection, refreshToken, fetchOptions) => {
      const job = await refreshQoderJobToken(refreshToken, fetchOptions)
      applyQoderJobTokenRefresh(connection, job)
    },
  }

export const OAUTH_REFRESH_LEAD_MS: Partial<Record<OAuthProviderId, number>> = {
  // Match CPA: refresh Codex credentials one day before expiry.
  codex: 24 * 60 * 60 * 1000,
  claude: 4 * 60 * 60 * 1000,
  // MiniMax Code 的 accessToken 只有 1 小时，提前量必须很小（实测 3600s），
  // 否则会出现“有效期比提前量还短”导致每次请求都续期。默认 5 分钟即可。
  minimax: 5 * 60 * 1000,
  // Qoder 的 job token 寿命由响应的 expires_in（毫秒）决定，可能很短；
  // 提前量取 5 分钟（也是 expires_in/2 的上限）。
  qoder: 5 * 60 * 1000,
}
