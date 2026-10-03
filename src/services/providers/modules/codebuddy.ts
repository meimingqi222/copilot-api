import { createCodebuddyAccountCreation } from "~/services/providers/account-creation/codebuddy"
import { scheduleCodebuddyRefresh } from "~/services/codebuddy/token-refresh"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import type { ProviderModule } from "~/services/providers/module"
import { codebuddyNativeAdapter } from "~/services/protocols/codebuddy-native"
import { codebuddyProviderRuntime } from "~/services/providers/codebuddy"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import {
  applyCodebuddyOAuthBundle,
  pollCodebuddyDeviceAuthorization,
  startCodebuddyDeviceFlow,
  type CodebuddyOAuthProviderId,
} from "~/services/oauth/codebuddy"

export function createCodebuddyStrategy(
  provider: CodebuddyOAuthProviderId,
): OAuthProviderStrategy {
  return {
    flowType: "device",
    async start({ proxyUrl }) {
      const loginFetchOptions = proxyUrl ? { proxyUrl } : undefined
      const s = await startCodebuddyDeviceFlow(provider, loginFetchOptions)
      return { authUrl: s.authUrl, state: s.state, interval: 5 }
    },
    async exchange({ flow, signal }) {
      if (!flow.state) {
        throw new Error("CodeBuddy OAuth flow is missing state")
      }
      const conn = createOAuthConnection(provider, flow.label)
      applyFlowSettingsToConnection(conn, flow)
      const bundle = await pollCodebuddyDeviceAuthorization(
        provider,
        flow.state,
        { proxyUrl: flow.proxyUrl, signal },
      )
      applyCodebuddyOAuthBundle(conn, provider, bundle)
      return conn
    },
  }
}

const codebuddyStrategy = createCodebuddyStrategy("codebuddy")

export function getCodebuddyModule(): ProviderModule {
  return {
    id: "codebuddy",
    descriptor: getProviderDescriptor("codebuddy"),
    accountCreation: createCodebuddyAccountCreation("codebuddy"),
    afterAuthentication: scheduleCodebuddyRefresh,
    adapter: codebuddyNativeAdapter,
    createRuntime: () => codebuddyProviderRuntime,
    oauth: codebuddyStrategy,
  }
}
