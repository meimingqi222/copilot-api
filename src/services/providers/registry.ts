import type { Account } from "~/lib/accounts"
import type {
  ProviderDescriptor,
  ProviderFeature,
  ProviderId,
} from "~/lib/provider-config"

import { isProviderId } from "~/lib/provider-config"

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

export function providerSupports(
  account: Account,
  feature: ProviderFeature,
): boolean {
  return getProviderRuntime(account.provider).supports(account, feature)
}

export function tryGetProviderRuntime(
  provider: string | undefined,
): ProviderRuntime | undefined {
  if (!provider || !isProviderId(provider)) {
    return undefined
  }
  return providerRegistry.get(provider)
}
