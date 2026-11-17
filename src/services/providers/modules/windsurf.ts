import { windsurfCallbackConfig } from "~/services/providers/callbacks/windsurf"
import { windsurfAccountCreation } from "~/services/providers/account-creation/windsurf"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { getConnectionSettings } from "~/lib/provider-connections"
import type { ProviderModule } from "~/services/providers/module"
import { windsurfNativeAdapter } from "~/services/protocols/windsurf-native"
import { windsurfProviderRuntime } from "~/services/providers/windsurf"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import {
  applyWindsurfOAuthBundle,
  createWindsurfOAuthStart,
  exchangeWindsurfCodeForToken,
  fetchWindsurfSelfProfile,
  formatWindsurfSessionToken,
  isWindsurfSessionToken,
} from "~/services/oauth/windsurf"

const windsurfStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const s = createWindsurfOAuthStart()
    return Promise.resolve({
      authUrl: s.authUrl,
      state: s.state,
      pkce: s.pkce,
      redirectUri: s.redirectUri,
    })
  },
  async exchange({ flow, code }) {
    if (!flow.pkce) {
      throw new Error("Windsurf OAuth flow is missing PKCE codes")
    }
    if (!code) {
      throw new Error("Windsurf OAuth exchange requires an authorization code")
    }
    const conn = createOAuthConnection("windsurf", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    // Headless manual paste may carry a session token directly
    // (CPA `parseDevinManualPaste` parity): skip the code exchange.
    const pasted = code.trim()
    const bundle =
      isWindsurfSessionToken(pasted) ?
        { sessionToken: formatWindsurfSessionToken(pasted) }
      : await exchangeWindsurfCodeForToken(
          pasted,
          flow.pkce.codeVerifier,
          flowFetchOptions(flow),
          flow.redirectUri,
        )
    const settings = getConnectionSettings(conn) as
      | { baseUrl?: string }
      | undefined
    const profile = await fetchWindsurfSelfProfile(
      bundle.sessionToken,
      flowFetchOptions(flow),
      settings?.baseUrl,
    )
    applyWindsurfOAuthBundle(conn, { ...bundle, ...profile })
    if (flow.label) conn.name = flow.label
    return conn
  },
}

export function getWindsurfModule(): ProviderModule {
  return {
    id: "windsurf",
    quota: { source: "poll" },
    descriptor: getProviderDescriptor("windsurf"),
    accountCreation: windsurfAccountCreation,
    callback: windsurfCallbackConfig,
    adapter: windsurfNativeAdapter,
    createRuntime: () => windsurfProviderRuntime,
    oauth: windsurfStrategy,
  }
}
