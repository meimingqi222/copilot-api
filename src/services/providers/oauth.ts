import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import { isOAuthProviderId, type OAuthProviderId } from "~/lib/provider-config"
import { getOAuthProviderDescriptor } from "~/lib/provider-config"
import {
  getConnectionProvider,
  getMutableProviderConnection,
  setConnectionModels,
} from "~/lib/provider-connections"
import { fetchOAuthProviderQuota } from "~/lib/quota"
import { refreshProviderQuota } from "~/lib/quota/refresh"
import {
  discoverOAuthModelsForConnection,
  getOAuthCatalogModelsForConnection,
} from "~/services/oauth/discover-models"
import { refreshOAuthConnectionToken } from "~/services/oauth/refresh-scheduler"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import type {
  ProviderQuota,
  ProviderRuntime,
} from "~/services/providers/runtime"

/** Provider-owned operations; defaults preserve the existing OAuth providers. */
interface OAuthRuntimeOperations {
  quota?: ProviderQuota
  discoverModels?(connection: ProviderConnection): Promise<Array<ModelMapping>>
  getFallbackModels?(connection: ProviderConnection): Array<ModelMapping>
  fetchQuota?(
    connection: ProviderConnection,
    signal?: AbortSignal,
  ): Promise<ProviderQuotaSnapshot | undefined>
}

export function createOAuthProviderRuntime(
  providerId: OAuthProviderId,
  operations: OAuthRuntimeOperations = {},
): ProviderRuntime {
  const descriptor = getOAuthProviderDescriptor(providerId)

  return {
    id: providerId,
    descriptor,
    quota: operations.quota,
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
      const discoverModels =
        operations.discoverModels ?? discoverOAuthModelsForConnection
      const models = await discoverModels(connection)
      setConnectionModels(connection, models)
      return models
    },
    getFallbackModels(connection) {
      const provider = getConnectionProvider(connection)
      if (provider !== providerId) {
        return []
      }
      const getFallbackModels =
        operations.getFallbackModels ?? getOAuthCatalogModelsForConnection
      return getFallbackModels(connection)
    },
    async refreshQuota(connection, signal, options) {
      const provider = getConnectionProvider(connection)
      if (provider !== providerId) {
        return undefined
      }

      const fetchQuota = operations.fetchQuota ?? fetchOAuthProviderQuota
      return refreshProviderQuota(connection, fetchQuota, signal, options)
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
