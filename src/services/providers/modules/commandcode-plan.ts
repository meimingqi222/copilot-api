import { commandcodePlanCallbackConfig } from "~/services/providers/callbacks/commandcode-plan"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { fetchCommandCodeQuota } from "~/lib/quota/fetchers/commandcode"
import type { ProviderModule } from "~/services/providers/module"
import { commandCodeNativeAdapter } from "~/services/protocols/commandcode-native"
import { commandCodeProviderRuntime } from "~/services/providers/commandcode"
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
  applyCommandCodeOAuthBundle,
  buildCommandCodeAuthUrl,
  finalizeCommandCodeBundle,
} from "~/services/oauth/commandcode"

const commandCodeStrategy: OAuthProviderStrategy = {
  flowType: "callback",
  start() {
    const state = generateOAuthState()
    return Promise.resolve({ authUrl: buildCommandCodeAuthUrl(state), state })
  },
  async exchange({ flow, code }) {
    if (!code) {
      throw new Error(
        "Command Code OAuth exchange requires the API key Studio posted",
      )
    }
    const conn = createOAuthConnection("commandcode-plan", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await finalizeCommandCodeBundle(code, flowFetchOptions(flow))
    applyCommandCodeOAuthBundle(conn, bundle)
    upsertProviderConnection(conn)
    return conn
  },
}

const refreshAuth: OAuthRefreshFn = async () => {
  // no-op: the minted API key does not rotate
}

export function getCommandCodeModule(): ProviderModule {
  return {
    id: "commandcode-plan",
    descriptor: getProviderDescriptor("commandcode-plan"),
    callback: commandcodePlanCallbackConfig,
    fetchQuota: fetchCommandCodeQuota,
    fallbackModels: () => [],
    adapter: commandCodeNativeAdapter,
    createRuntime: () => commandCodeProviderRuntime,
    oauth: commandCodeStrategy,
    refreshAuth,
  }
}
