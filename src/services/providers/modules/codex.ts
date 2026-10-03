import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import { codexCallbackConfig } from "~/services/providers/callbacks/codex"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { accountModelsToMappings } from "~/services/providers/model-catalogs/account-mapping"
import { getCodexModelsForConnection } from "~/services/codex/get-models"
import { getCodexFallbackModels } from "~/services/providers/model-catalogs/codex"
import { fetchCodexQuota } from "~/lib/quota/fetchers/codex"
import type { ProviderModule } from "~/services/providers/module"
import { codexNativeAdapter } from "~/services/protocols/codex-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import { getCredentialContextString } from "~/lib/provider-connections"
import {
  applyCodexOAuthBundle,
  createCodexOAuthStart,
  exchangeCodexCodeForTokens,
  refreshCodexTokens,
} from "~/services/oauth/codex"
import {
  codexCliRefreshTokenIfRotated,
  writeCodexCliCredentials,
} from "~/services/oauth/codex-cli-auth"

const codexStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const s = createCodexOAuthStart()
    return Promise.resolve({ authUrl: s.authUrl, state: s.state, pkce: s.pkce })
  },
  async exchange({ flow, code }) {
    if (!flow.pkce) {
      throw new Error("Codex OAuth flow is missing PKCE codes")
    }
    if (!code) {
      throw new Error("Codex OAuth exchange requires an authorization code")
    }
    const conn = createOAuthConnection("codex", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await exchangeCodexCodeForTokens(
      code,
      flow.pkce,
      flowFetchOptions(flow),
    )
    applyCodexOAuthBundle(conn, bundle)
    return conn
  },
}

const refreshAuth = prepareOAuthRefresh(
  async (connection, refreshToken, fetchOptions) => {
    const accountId = getCredentialContextString(connection, "oauthAccountId")
    // The Codex CLI shares this account's rotating refresh token: adopt its
    // token when it has rotated since ours, then write ours back after, so
    // neither side ever spends a token the other already used.
    const cliRefresh = await codexCliRefreshTokenIfRotated(
      accountId,
      refreshToken,
    )
    const bundle = await refreshCodexTokens(
      cliRefresh ?? refreshToken,
      fetchOptions,
    )
    applyCodexOAuthBundle(connection, bundle)
    await writeCodexCliCredentials(accountId, {
      accessToken: bundle.accessToken,
      idToken: bundle.idToken,
      refreshToken: bundle.refreshToken,
      accountId,
    })
  },
)

export function getCodexModule(): ProviderModule {
  return {
    id: "codex",
    descriptor: getProviderDescriptor("codex"),
    callback: codexCallbackConfig,
    fetchQuota: fetchCodexQuota,
    fallbackModels: getCodexFallbackModels,
    async discoverModels(connection, signal) {
      return accountModelsToMappings(
        await getCodexModelsForConnection(connection, signal),
      )
    },
    adapter: codexNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("codex"),
    oauth: codexStrategy,
    refreshAuth,
    refreshLeadMs: 24 * 60 * 60 * 1000,
  }
}
