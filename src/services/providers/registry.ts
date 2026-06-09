import type { ProviderDescriptor, ProviderId } from "~/lib/provider-config"

import type { ProviderRuntime } from "./runtime"

const providerRegistry = new Map<ProviderId, ProviderRuntime>()

export function registerProvider(runtime: ProviderRuntime): void {
  providerRegistry.set(runtime.id, runtime)
}

export function getProviderRuntime(provider: ProviderId): ProviderRuntime {
  const runtime = providerRegistry.get(provider)
  if (!runtime) {
    throw new Error(`Provider runtime "${provider}" is not registered`)
  }
  return runtime
}

export function listProviderDescriptors(): Array<ProviderDescriptor> {
  return Array.from(providerRegistry.values()).map(
    (runtime) => runtime.descriptor,
  )
}
