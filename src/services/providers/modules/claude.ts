import { prepareOAuthRefresh } from "~/services/providers/auth-update"
import { claudeCallbackConfig } from "~/services/providers/callbacks/claude"
import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { accountModelsToMappings } from "~/services/providers/model-catalogs/account-mapping"
import { getClaudeModelsForConnection } from "~/services/claude/get-models"
import { getClaudeFallbackModels } from "~/services/providers/model-catalogs/claude"
import { fetchClaudeQuota } from "~/lib/quota/fetchers/claude"
import type { ProviderModule } from "~/services/providers/module"
import { claudeNativeAdapter } from "~/services/protocols/claude-native"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"
import {
  createOAuthConnection,
  applyFlowSettingsToConnection,
  flowFetchOptions,
  type OAuthProviderStrategy,
} from "~/services/oauth/strategy-types"
import {
  applyClaudeOAuthBundle,
  createClaudeOAuthStart,
  exchangeClaudeCodeForTokens,
  fetchClaudeBootstrapIdentity,
  refreshClaudeTokens,
} from "~/services/oauth/claude"

const claudeStrategy: OAuthProviderStrategy = {
  flowType: "pkce-callback",
  start() {
    const s = createClaudeOAuthStart()
    return Promise.resolve({ authUrl: s.authUrl, state: s.state, pkce: s.pkce })
  },
  async exchange({ flow, code }) {
    if (!flow.state) {
      throw new Error("Claude OAuth flow is missing state")
    }
    if (!flow.pkce) {
      throw new Error("Claude OAuth flow is missing PKCE codes")
    }
    if (!code) {
      throw new Error("Claude OAuth exchange requires an authorization code")
    }
    const conn = createOAuthConnection("claude", flow.label)
    applyFlowSettingsToConnection(conn, flow)
    const bundle = await exchangeClaudeCodeForTokens(
      code,
      flow.state,
      flow.pkce,
      flowFetchOptions(flow),
    )
    // Best-effort bootstrap: recover account_uuid/email for the request
    // fingerprint (metadata.user_id.account_uuid). Login-only - identity is
    // captured once, never rewritten during refresh (oh-my-pi convention).
    if (!bundle.accountId || !bundle.email || !bundle.organizationId) {
      const identity = await fetchClaudeBootstrapIdentity(
        bundle.accessToken,
        flowFetchOptions(flow),
      )
      bundle.accountId = bundle.accountId ?? identity.accountId
      bundle.email = bundle.email ?? identity.email
      bundle.organizationId = bundle.organizationId ?? identity.organizationId
      bundle.organizationName =
        bundle.organizationName ?? identity.organizationName
    }
    applyClaudeOAuthBundle(conn, bundle)
    return conn
  },
}

const refreshAuth = prepareOAuthRefresh(
  async (connection, refreshToken, fetchOptions) => {
    const bundle = await refreshClaudeTokens(refreshToken, fetchOptions)
    applyClaudeOAuthBundle(connection, bundle)
  },
)

export function getClaudeModule(): ProviderModule {
  return {
    id: "claude",
    descriptor: getProviderDescriptor("claude"),
    callback: claudeCallbackConfig,
    fetchQuota: fetchClaudeQuota,
    fallbackModels: getClaudeFallbackModels,
    async discoverModels(connection, signal) {
      return accountModelsToMappings(
        await getClaudeModelsForConnection(connection, signal),
      )
    },
    adapter: claudeNativeAdapter,
    createRuntime: () => createOAuthProviderRuntime("claude"),
    oauth: claudeStrategy,
    refreshAuth,
    refreshLeadMs: 4 * 60 * 60 * 1000,
  }
}
