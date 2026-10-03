import { OAUTH_PROVIDER_IDS, type OAuthProviderId } from "~/lib/provider-config"
import {
  applyProviderAuthUpdate,
  type OAuthRefreshOperation,
} from "~/services/providers/auth-update"
import { getBuiltinProviderModule } from "~/services/providers/builtins"

// Lazy compatibility views avoid initializing runtimes during module loading.
export const OAUTH_REFRESH_STRATEGIES = Object.defineProperties(
  {},
  Object.fromEntries(
    OAUTH_PROVIDER_IDS.map((id) => [
      id,
      {
        enumerable: true,
        get:
          (): OAuthRefreshOperation =>
          async (connection, refreshToken, options) => {
            const refresh = getBuiltinProviderModule(id)?.refreshAuth
            if (!refresh)
              throw new Error(`Missing provider refresh operation: ${id}`)
            const update = await refresh(connection, refreshToken, options)
            applyProviderAuthUpdate(connection, update)
          },
      },
    ]),
  ),
) as Record<OAuthProviderId, OAuthRefreshOperation>

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
