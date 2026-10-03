import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import { antigravityCallbackConfig } from "~/services/providers/callbacks/antigravity"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { accountModelsToMappings } from "~/services/providers/model-catalogs/account-mapping"
import { getAntigravityModelsForConnection } from "~/services/antigravity/get-models"
import { getAntigravityFallbackModels } from "~/services/providers/model-catalogs/antigravity"
import { fetchAntigravityQuota } from "~/lib/quota/fetchers/antigravity"
import type { ProviderModule } from "~/services/providers/module"
import { antigravityNativeAdapter } from "~/services/protocols/antigravity-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import { getConnectionRedirectUri } from "~/lib/provider-connections"
import {
  applyAntigravityOAuthBundle,
  createAntigravityOAuthStart,
  exchangeAntigravityCodeForTokens,
  ANTIGRAVITY_REDIRECT_URI,
  refreshAntigravityTokens,
} from "~/services/oauth/antigravity"

const antigravityStrategy: OAuthProviderStrategy = {
  flowType: "callback",
  start() {
    const s = createAntigravityOAuthStart()
    return Promise.resolve({
      authUrl: s.authUrl,
      state: s.state,
      redirectUri: s.redirectUri,
    })
  },
  async exchange({ flow, code }) {
    if (!flow.redirectUri) {
      throw new Error("Antigravity OAuth flow is missing redirect URI")
    }
    if (!code) {
      throw new Error(
        "Antigravity OAuth exchange requires an authorization code",
      )
    }
    const conn = createOAuthConnection("antigravity", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await exchangeAntigravityCodeForTokens(
      code,
      flow.redirectUri,
      flowFetchOptions(flow),
    )
    applyAntigravityOAuthBundle(conn, bundle)
    return conn
  },
}

const refreshAuth = prepareOAuthRefresh(
  async (connection, refreshToken, fetchOptions) => {
    const bundle = await refreshAntigravityTokens(refreshToken, fetchOptions)
    applyAntigravityOAuthBundle(connection, {
      ...bundle,
      redirectUri:
        getConnectionRedirectUri(connection) ?? ANTIGRAVITY_REDIRECT_URI,
    })
  },
)

export function getAntigravityModule(): ProviderModule {
  return {
    id: "antigravity",
    descriptor: getProviderDescriptor("antigravity"),
    callback: antigravityCallbackConfig,
    fetchQuota: fetchAntigravityQuota,
    fallbackModels: getAntigravityFallbackModels,
    async discoverModels(connection, signal) {
      return accountModelsToMappings(
        await getAntigravityModelsForConnection(connection, signal),
      )
    },
    adapter: antigravityNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("antigravity"),
    oauth: antigravityStrategy,
    refreshAuth,
  }
}
