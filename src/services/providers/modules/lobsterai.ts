import { lobsteraiCallbackConfig } from "~/services/providers/callbacks/lobsterai"
import { lobsteraiAccountCreation } from "~/services/providers/account-creation/lobsterai"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import type { ProviderModule } from "~/services/providers/module"
import { lobsteraiNativeAdapter } from "~/services/protocols/lobsterai-native"
import { lobsteraiProviderRuntime } from "~/services/providers/lobsterai"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import { upsertProviderConnection } from "~/lib/provider-connections"
import {
  applyLobsteraiOAuthTokens,
  createLobsteraiOAuthStart,
  exchangeLobsteraiCode,
} from "~/services/oauth/lobsterai"

const lobsteraiStrategy: OAuthProviderStrategy = {
  flowType: "callback",
  start({ proxyUrl }) {
    return createLobsteraiOAuthStart(proxyUrl ? { proxyUrl } : undefined).then(
      ({ authUrl, state, installationUuid }) => ({
        authUrl,
        state,
        nonce: installationUuid,
      }),
    )
  },
  async exchange({ flow, code }) {
    if (!code || !flow.nonce) {
      throw new Error(
        "LobsterAI OAuth flow is missing code or installation UUID",
      )
    }
    const conn = createOAuthConnection("lobsterai", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const tokens = await exchangeLobsteraiCode(
      code,
      flow.nonce,
      flowFetchOptions(flow),
    )
    if (!tokens) throw new Error("LobsterAI exchange returned no token data")
    applyLobsteraiOAuthTokens(conn, tokens, flow.nonce)
    upsertProviderConnection(conn)
    return conn
  },
}

export function getLobsteraiModule(): ProviderModule {
  return {
    id: "lobsterai",
    descriptor: getProviderDescriptor("lobsterai"),
    accountCreation: lobsteraiAccountCreation,
    callback: lobsteraiCallbackConfig,
    adapter: lobsteraiNativeAdapter,
    createRuntime: () => lobsteraiProviderRuntime,
    oauth: lobsteraiStrategy,
  }
}
