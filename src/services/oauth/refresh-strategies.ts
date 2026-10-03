import { OAUTH_PROVIDER_IDS, type OAuthProviderId } from "~/lib/provider-config"
import type { OAuthRefreshFn } from "~/services/oauth/strategy-types"
import { getBuiltinProviderModule } from "~/services/providers/builtins"

// Lazy compatibility views avoid initializing runtimes during module loading.
export const OAUTH_REFRESH_STRATEGIES = Object.defineProperties(
  {},
  Object.fromEntries(
    OAUTH_PROVIDER_IDS.map((id) => [
      id,
      {
        enumerable: true,
        get: () => getBuiltinProviderModule(id)?.refreshAuth,
      },
    ]),
  ),
) as Record<OAuthProviderId, OAuthRefreshFn>

export const OAUTH_REFRESH_LEAD_MS = Object.defineProperties(
  {},
  Object.fromEntries(
    OAUTH_PROVIDER_IDS.map((id) => [
      id,
      {
        enumerable: true,
        get: () => getBuiltinProviderModule(id)?.refreshLeadMs,
      },
    ]),
  ),
) as Partial<Record<OAuthProviderId, number>>
