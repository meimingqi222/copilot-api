import { providerMetadata } from "~/lib/provider-descriptors/wps-lingxi"
import {
  mergeProviderRefreshedModels,
  setConnectionModels,
} from "~/lib/provider-connections"
import { refreshProviderQuota } from "~/lib/quota/refresh"
import { wpsLingxiNativeAdapter } from "~/services/protocols/wps-lingxi-native"
import type { ProviderModule } from "~/services/providers/module"
import { lingxiAccountCreation } from "~/services/wps-lingxi/account"
import {
  discoverLingxiModels,
  fallbackLingxiModels,
  fetchLingxiQuota,
} from "~/services/wps-lingxi/models-quota"

export function getWpsLingxiModule(): ProviderModule {
  const { descriptor, protocol } = providerMetadata
  const quota = { source: "poll" } as const
  return {
    id: descriptor.id,
    descriptor,
    quota,
    adapter: wpsLingxiNativeAdapter,
    accountCreation: lingxiAccountCreation,
    discoverModels: discoverLingxiModels,
    fallbackModels: fallbackLingxiModels,
    fetchQuota: fetchLingxiQuota,
    createRuntime: () => ({
      id: descriptor.id,
      descriptor,
      quota,
      supports: (connection, feature) =>
        connection.protocol === protocol
        && descriptor.features.includes(feature),
      async refreshModels(connection) {
        const discovered = await discoverLingxiModels(connection)
        const models = mergeProviderRefreshedModels(
          connection.models,
          discovered.length ? discovered : fallbackLingxiModels(),
        )
        setConnectionModels(connection, models)
        return models
      },
      getFallbackModels: fallbackLingxiModels,
      refreshQuota: (connection, signal, options) =>
        refreshProviderQuota(connection, fetchLingxiQuota, signal, options),
    }),
  }
}
