import { xaiCallbackConfig } from "~/services/providers/callbacks/xai"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { getXaiFallbackModels } from "~/services/providers/model-catalogs/xai"
import { fetchXaiQuota } from "~/lib/quota/fetchers/xai"
import type { ProviderModule } from "~/services/providers/module"
import { xaiNativeAdapter } from "~/services/protocols/xai-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
  type OAuthRefreshFn,
} from "~/services/oauth/strategy-types"
import { upsertProviderConnection } from "~/lib/provider-connections"
import {
  applyXaiOAuthBundle,
  createXaiOAuthStart,
  discoverXaiOAuthEndpoints,
  exchangeXaiCodeForTokens,
  getXaiTokenEndpoint,
  refreshXaiTokens,
} from "~/services/oauth/xai"

const xaiStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  async start({ proxyUrl }) {
    const loginFetchOptions = proxyUrl ? { proxyUrl } : undefined
    const discovery = await discoverXaiOAuthEndpoints(loginFetchOptions)
    const s = createXaiOAuthStart(discovery)
    return {
      authUrl: s.authUrl,
      state: s.state,
      pkce: s.pkce,
      tokenEndpoint: s.tokenEndpoint,
      nonce: s.nonce,
    }
  },
  async exchange({ flow, code }) {
    if (!flow.pkce) {
      throw new Error("xAI OAuth flow is missing PKCE codes")
    }
    if (!flow.tokenEndpoint) {
      throw new Error("xAI OAuth flow is missing token endpoint")
    }
    if (!code) {
      throw new Error("xAI OAuth exchange requires an authorization code")
    }
    const conn = createOAuthConnection("xai", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await exchangeXaiCodeForTokens(
      code,
      flow.pkce,
      flow.tokenEndpoint,
      flowFetchOptions(flow),
    )
    applyXaiOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

const refreshAuth: OAuthRefreshFn = async (
  connection,
  refreshToken,
  fetchOptions,
) => {
  const tokenEndpoint = getXaiTokenEndpoint(connection) ?? ""
  const bundle = await refreshXaiTokens(
    refreshToken,
    tokenEndpoint,
    fetchOptions,
  )
  applyXaiOAuthBundle(connection, bundle)
}

export function getXaiModule(): ProviderModule {
  return {
    id: "xai",
    descriptor: getProviderDescriptor("xai"),
    callback: xaiCallbackConfig,
    fetchQuota: fetchXaiQuota,
    fallbackModels: getXaiFallbackModels,
    adapter: xaiNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("xai"),
    oauth: xaiStrategy,
    refreshAuth,
  }
}
