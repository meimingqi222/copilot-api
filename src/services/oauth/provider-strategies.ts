import { OAUTH_PROVIDER_IDS, type OAuthProviderId } from "~/lib/provider-config"
import type { OAuthFlowProvider } from "~/services/oauth/flows"
import type { OAuthProviderStrategy } from "~/services/oauth/strategy-types"
import { getBuiltinProviderModule } from "~/services/providers/builtins"

export { createOAuthConnection } from "~/services/oauth/strategy-types"

// Compatibility view; implementations are owned by each provider module.
export const OAUTH_PROVIDER_STRATEGIES = Object.defineProperties(
  {},
  Object.fromEntries(
    OAUTH_PROVIDER_IDS.map((id) => [
      id,
      { enumerable: true, get: () => getOAuthStrategy(id) },
    ]),
  ),
) as Record<OAuthProviderId, OAuthProviderStrategy>

export function getOAuthStrategy(
  provider: string,
): OAuthProviderStrategy | undefined {
  return getBuiltinProviderModule(provider)?.oauth
}

export function isOAuthCapableProvider(
  provider: string,
): provider is OAuthFlowProvider {
  return getOAuthStrategy(provider) !== undefined
}

export function isCallbackOAuthCapableProvider(
  provider: string,
): provider is OAuthFlowProvider {
  const strategy = getOAuthStrategy(provider)
  return (
    strategy?.flowType === "pkce-callback" || strategy?.flowType === "callback"
  )
}
