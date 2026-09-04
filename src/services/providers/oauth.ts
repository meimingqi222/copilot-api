import { saveAccounts } from "~/lib/account-store"
import { isOAuthProviderId, type OAuthProviderId } from "~/lib/provider-config"
import { getOAuthProviderDescriptor } from "~/lib/provider-config"
import {
  getConnectionProvider,
  getMutableProviderConnection,
  setConnectionModels,
} from "~/lib/provider-connections"
import { applyOAuthQuotaSnapshot, fetchOAuthProviderQuota } from "~/lib/quota"
import {
  discoverOAuthModelsForConnection,
  getOAuthCatalogModelsForConnection,
} from "~/services/oauth/discover-models"
import { refreshOAuthConnectionToken } from "~/services/oauth/refresh-scheduler"

import type { ProviderRuntime } from "./runtime"

export function createOAuthProviderRuntime(
  providerId: OAuthProviderId,
): ProviderRuntime {
  const descriptor = getOAuthProviderDescriptor(providerId)

  return {
    id: providerId,
    descriptor,
    supports(connection, feature) {
      const provider = getConnectionProvider(connection)
      if (provider !== providerId) return false
      if (!isOAuthProviderId(provider)) return false
      return descriptor.features.includes(feature)
    },
    async refreshModels(connection) {
      const provider = getConnectionProvider(connection)
      if (provider !== providerId) {
        return []
      }
      const models = await discoverOAuthModelsForConnection(connection)
      setConnectionModels(connection, models)
      return models
    },
    getFallbackModels(connection) {
      const provider = getConnectionProvider(connection)
      if (provider !== providerId) {
        return []
      }
      return getOAuthCatalogModelsForConnection(connection)
    },
    async refreshQuota(connection) {
      const provider = getConnectionProvider(connection)
      if (provider !== providerId) {
        return undefined
      }

      const liveConnection = getMutableProviderConnection(connection.id)
      if (!liveConnection) {
        return undefined
      }

      const snapshot = await fetchOAuthProviderQuota(liveConnection)
      if (!snapshot) {
        return undefined
      }

      applyOAuthQuotaSnapshot(liveConnection, snapshot)
      await saveAccounts()
      return snapshot
    },
    refreshAuth(connection) {
      const provider = getConnectionProvider(connection)
      if (provider !== providerId) {
        return Promise.resolve()
      }
      const liveConnection = getMutableProviderConnection(connection.id)
      if (!liveConnection) {
        return Promise.resolve()
      }
      return refreshOAuthConnectionToken(liveConnection, "manual")
    },
  }
}
