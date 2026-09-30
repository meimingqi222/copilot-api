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
import { applyFactoryTokenRefresh, refreshFactoryTokens } from "./factory"
import {
  applyDimagentOAuthBundle,
  dimagentBundle,
  refreshDimagentTokens,
} from "./dimagent"
import { applyGeminiOAuthBundle, refreshGeminiTokens } from "./gemini"
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
    // Factory 的 WorkOS 刷新会轮换 refresh token，写回由 applyFactoryTokenRefresh
    // 完成（串行由刷新调度保证）。
    factory: async (connection, refreshToken, fetchOptions) => {
      const tokens = await refreshFactoryTokens(refreshToken, fetchOptions)
      applyFactoryTokenRefresh(connection, tokens)
    },
    // ZCode 的 key `<id>.<secret>` 是长期凭证，不轮换；这里保留 no-op 以满足
    // 穷尽表（只有存在 refreshToken 时调度才会调用，zcode 没有）。
    zcode: async () => {
      // no-op: the minted API key does not rotate
    },
    // Command Code 的 key 也是长期凭证，不轮换。
    "commandcode-plan": async () => {
      // no-op: the minted API key does not rotate
    },
    // Zed 的账号 token 长期有效（直到 401 才要重登），不轮换。
    zed: async () => {
      // no-op: the Zed account token does not rotate
    },
    // DimAgent 的 refresh token 会轮换，写回新对。
    dimagent: async (connection, refreshToken, fetchOptions) => {
      const tokens = await refreshDimagentTokens(refreshToken, fetchOptions)
      applyDimagentOAuthBundle(connection, dimagentBundle(tokens))
    },
    // Gemini 的 Google token 会轮换 refresh token，写回新对（project 保留）。
    gemini: async (connection, refreshToken, fetchOptions) => {
      const tokens = await refreshGeminiTokens(refreshToken, fetchOptions)
      const cred = connection.credentials[0]
      const project = cred?.context?.projectId as string | undefined
      applyGeminiOAuthBundle(connection, {
        accessToken: tokens.access_token ?? "",
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        project: project ?? "",
      })
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
  // Factory 的 WorkOS access token 约 1 小时，droid 提前 1 分钟续期；这里留宽。
  factory: 2 * 60 * 1000,
}
