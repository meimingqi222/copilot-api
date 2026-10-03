import type { OAuthProviderId } from "~/lib/provider-config"
import type { ModelMapping } from "~/lib/provider-connections"
import { getBuiltinProviderModule } from "~/services/providers/builtins"
export { resolveXaiModelId } from "~/services/providers/model-catalogs/xai"

/** Compatibility view of the provider-owned offline model catalog. */
export function getOAuthFallbackModelsForConnection(
  provider: OAuthProviderId,
): Array<ModelMapping> {
  return getBuiltinProviderModule(provider)?.fallbackModels?.() ?? []
}
