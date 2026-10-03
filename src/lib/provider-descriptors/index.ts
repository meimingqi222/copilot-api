import type { ProviderId } from "~/lib/provider-definitions"
import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { PROVIDER_METADATA_ENTRIES } from "~/lib/provider-metadata"

/** Pure account descriptions, available before runtime initialization. */
export const PROVIDER_DESCRIPTORS = Object.fromEntries(
  PROVIDER_METADATA_ENTRIES.map((entry) => [
    entry.descriptor.id,
    entry.descriptor,
  ]),
) as Record<ProviderId, ProviderDescriptor>

export function getProviderDescriptor(id: ProviderId): ProviderDescriptor {
  return PROVIDER_DESCRIPTORS[id]
}

export type {
  ProviderDescriptor,
  ProviderFeature,
  ProviderFieldOption,
  ProviderFieldSchema,
  ProviderPresentation,
} from "~/lib/provider-descriptors/types"
export { PROVIDER_FEATURES } from "~/lib/provider-descriptors/types"
