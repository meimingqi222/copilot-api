import { geminiCallbackConfig } from "~/services/providers/callbacks/gemini"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { fetchGeminiQuota } from "~/lib/quota/fetchers/gemini"
import type { ProviderModule } from "~/services/providers/module"
import { geminiNativeAdapter } from "~/services/protocols/gemini-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
  type OAuthRefreshFn,
} from "~/services/oauth/strategy-types"
import { upsertProviderConnection } from "~/lib/provider-connections"
import { generateOAuthState } from "~/services/oauth/pkce"
import {
  applyGeminiOAuthBundle,
  buildGeminiAuthUrl,
  exchangeGeminiCode,
  fetchGeminiUserInfo,
  geminiBundle,
  newGeminiPkce,
  resolveGeminiProject,
  refreshGeminiTokens,
} from "~/services/oauth/gemini"

const geminiStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const pkce = newGeminiPkce()
    const state = generateOAuthState()
    return Promise.resolve({
      authUrl: buildGeminiAuthUrl(state, pkce),
      state,
      pkce,
    })
  },
  async exchange({ flow, code }) {
    if (!flow.pkce) {
      throw new Error("Gemini OAuth flow is missing PKCE codes")
    }
    if (!code) {
      throw new Error("Gemini OAuth exchange requires an authorization code")
    }
    const options = flowFetchOptions(flow)
    const tokens = await exchangeGeminiCode(code, flow.pkce, options)
    const project = await resolveGeminiProject(
      tokens.access_token ?? "",
      options,
    )
    const user = await fetchGeminiUserInfo(tokens.access_token ?? "", options)
    const conn = createOAuthConnection("gemini", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    applyGeminiOAuthBundle(conn, geminiBundle(tokens, project, user))
    upsertProviderConnection(conn)
    return conn
  },
}

const refreshAuth: OAuthRefreshFn = async (
  connection,
  refreshToken,
  fetchOptions,
) => {
  const tokens = await refreshGeminiTokens(refreshToken, fetchOptions)
  const cred = connection.credentials[0]
  const project = cred?.context?.projectId as string | undefined
  applyGeminiOAuthBundle(connection, {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    project: project ?? "",
  })
}

export function getGeminiModule(): ProviderModule {
  return {
    id: "gemini",
    descriptor: getProviderDescriptor("gemini"),
    callback: geminiCallbackConfig,
    fetchQuota: fetchGeminiQuota,
    fallbackModels: () => [],
    adapter: geminiNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("gemini"),
    oauth: geminiStrategy,
    refreshAuth,
  }
}
