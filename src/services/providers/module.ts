import type { ProviderId } from "~/lib/provider-config"
import type {
  OAuthProviderStrategy,
  OAuthRefreshFn,
} from "~/services/oauth/strategy-types"
import type { ProtocolAdapter } from "~/services/protocols/types"
import type { ProviderRuntime } from "~/services/providers/runtime"
import { isOAuthProviderId, PROVIDER_PROTOCOL_MAP } from "~/lib/provider-config"
import type { ProviderDescriptor } from "~/lib/provider-config"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { QuotaSnapshot } from "~/lib/quota/types"
import type { ProviderAccountCreation } from "~/services/providers/account-creation/types"
import type { OAuthCallbackConfig } from "~/services/providers/callbacks/types"

/** Internal provider contribution. Loaded with the application, never from npm. */
export interface ProviderModule {
  id: ProviderId
  descriptor: ProviderDescriptor
  adapter: ProtocolAdapter
  createRuntime(): ProviderRuntime
  /** Login capability is independent of legacy OAuth account classification. */
  oauth?: OAuthProviderStrategy
  refreshAuth?: OAuthRefreshFn
  refreshLeadMs?: number
  accountCreation?: ProviderAccountCreation
  callback?: OAuthCallbackConfig
  fallbackModels?(): Array<ModelMapping>
  discoverModels?(
    connection: ProviderConnection,
    signal?: AbortSignal,
  ): Promise<Array<ModelMapping>>
  fetchQuota?(
    connection: ProviderConnection,
    signal?: AbortSignal,
  ): Promise<QuotaSnapshot | undefined>
}

/** Check the whole set before registering anything. Shared adapter instances are valid. */
export function validateProviderModules(
  modules: ReadonlyArray<ProviderModule>,
): void {
  const ids = new Set<ProviderId>()
  const adapters = new Map<string, ProtocolAdapter>()
  for (const module of modules) {
    if (ids.has(module.id))
      throw new Error(`Duplicate provider module: ${module.id}`)
    ids.add(module.id)
    if (module.descriptor.id !== module.id) {
      throw new Error(
        `Provider descriptor does not match module "${module.id}"`,
      )
    }
    if (PROVIDER_PROTOCOL_MAP[module.id] !== module.adapter.protocol) {
      throw new Error(`Provider protocol does not match module "${module.id}"`)
    }
    const existing = adapters.get(module.adapter.protocol)
    if (existing && existing !== module.adapter) {
      throw new Error(
        `Conflicting provider adapters: ${module.adapter.protocol}`,
      )
    }
    adapters.set(module.adapter.protocol, module.adapter)
    if (
      isOAuthProviderId(module.id)
      && (!module.oauth || !module.refreshAuth)
    ) {
      throw new Error(`OAuth provider module is incomplete: ${module.id}`)
    }
  }
}
