import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import { dimagentCallbackConfig } from "~/services/providers/callbacks/dimagent"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { fetchDimagentQuota } from "~/lib/quota/fetchers/dimagent"
import type { ProviderModule } from "~/services/providers/module"
import { dimagentNativeAdapter } from "~/services/protocols/dimagent-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import { generateOAuthState } from "~/services/oauth/pkce"
import {
  applyDimagentOAuthBundle,
  buildDimagentAuthUrl,
  dimagentBundle,
  exchangeDimagentCode,
  newDimagentPkce,
  refreshDimagentTokens,
} from "~/services/oauth/dimagent"

const dimagentStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const pkce = newDimagentPkce()
    const state = generateOAuthState()
    return Promise.resolve({
      authUrl: buildDimagentAuthUrl(state, pkce),
      state,
      pkce,
    })
  },
  async exchange({ flow, code }) {
    if (!flow.pkce) {
      throw new Error("DimAgent OAuth flow is missing PKCE codes")
    }
    if (!code) {
      throw new Error("DimAgent OAuth exchange requires an authorization code")
    }
    const conn = createOAuthConnection("dimagent", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const tokens = await exchangeDimagentCode(
      code,
      flow.pkce,
      flowFetchOptions(flow),
    )
    applyDimagentOAuthBundle(conn, dimagentBundle(tokens))
    return conn
  },
}

const refreshAuth = prepareOAuthRefresh(
  async (connection, refreshToken, fetchOptions) => {
    const tokens = await refreshDimagentTokens(refreshToken, fetchOptions)
    applyDimagentOAuthBundle(connection, dimagentBundle(tokens))
  },
)

export function getDimagentModule(): ProviderModule {
  return {
    id: "dimagent",
    descriptor: getProviderDescriptor("dimagent"),
    callback: dimagentCallbackConfig,
    fetchQuota: fetchDimagentQuota,
    fallbackModels: () => [],
    adapter: dimagentNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("dimagent"),
    oauth: dimagentStrategy,
    refreshAuth,
  }
}
