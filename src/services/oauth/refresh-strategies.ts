import type { OAuthAccount } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { getOAuthDeviceId, setOAuthCredentials } from "~/lib/accounts"

import type { OAuthFetchOptions } from "./fetch"

import {
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
  account: OAuthAccount,
  refreshToken: string,
  fetchOptions: OAuthFetchOptions,
) => Promise<void>

export const OAUTH_REFRESH_STRATEGIES: Record<OAuthProviderId, OAuthRefreshFn> =
  {
    claude: async (account, refreshToken, fetchOptions) => {
      const bundle = await refreshClaudeTokens(refreshToken, fetchOptions)
      applyClaudeOAuthBundle(account, bundle)
    },
    kimi: async (account, refreshToken, fetchOptions) => {
      const deviceId = createKimiDeviceId(getOAuthDeviceId(account))
      const bundle = await refreshKimiTokens(
        refreshToken,
        deviceId,
        fetchOptions,
      )
      applyKimiOAuthBundle(account, bundle)
      if (!getOAuthDeviceId(account)) {
        setOAuthCredentials(account, { deviceId })
      }
    },
    codex: async (account, refreshToken, fetchOptions) => {
      const bundle = await refreshCodexTokens(refreshToken, fetchOptions)
      applyCodexOAuthBundle(account, bundle)
    },
    antigravity: async (account, refreshToken, fetchOptions) => {
      const bundle = await refreshAntigravityTokens(refreshToken, fetchOptions)
      applyAntigravityOAuthBundle(account, {
        ...bundle,
        redirectUri:
          account.settings?.redirectUri
          ?? "http://localhost:51121/oauth-callback",
      })
    },
    xai: async (account, refreshToken, fetchOptions) => {
      const tokenEndpoint = getXaiTokenEndpoint(account) ?? ""
      const bundle = await refreshXaiTokens(
        refreshToken,
        tokenEndpoint,
        fetchOptions,
      )
      applyXaiOAuthBundle(account, bundle)
    },
  }

export const OAUTH_REFRESH_LEAD_MS: Partial<Record<OAuthProviderId, number>> = {
  codex: 5 * 24 * 60 * 60 * 1000,
  claude: 4 * 60 * 60 * 1000,
}
