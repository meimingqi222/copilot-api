import { getProviderDescriptor } from "~/lib/provider-descriptors"
import { refreshProviderQuota } from "~/lib/quota/refresh"
import { studioAccountCreation } from "~/services/astudio/auth"
import {
  discoverStudioModels,
  studioFallbackModels,
} from "~/services/astudio/catalog"
import { fetchStudioQuota } from "~/services/astudio/quota"
import { studioNativeAdapter } from "~/services/protocols/astudio-native"
import type { ProviderModule } from "~/services/providers/module"

const quota = { source: "poll" } as const

export function getAstudioModule(): ProviderModule {
  const descriptor = getProviderDescriptor("astudio")
  return {
    id: "astudio",
    descriptor,
    adapter: studioNativeAdapter,
    quota,
    accountCreation: studioAccountCreation,
    discoverModels: discoverStudioModels,
    fallbackModels: studioFallbackModels,
    fetchQuota: fetchStudioQuota,
    createRuntime: () => ({
      id: "astudio",
      descriptor,
      quota,
      supports: (connection, feature) =>
        connection.protocol === "astudio-native"
        && descriptor.features.includes(feature),
      refreshModels: discoverStudioModels,
      getFallbackModels: (connection) =>
        connection.lastModelDiscoveryAt || connection.models?.length ?
          (connection.models ?? [])
        : studioFallbackModels(),
      refreshQuota: (connection, signal, options) =>
        refreshProviderQuota(connection, fetchStudioQuota, signal, options),
    }),
  }
}
