import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"

interface ProviderCredentials {
  primaryKey: string
  primarySource?: "context"
  requiredExtras?: ReadonlyArray<string>
  /** Omitted for OAuth exports, which retain provider-specific extra fields. */
  exportKeys?: ReadonlyArray<string>
}

/** Keep literal identity types without depending on the assembled provider catalog. */
export function defineProviderMetadata<
  const Id extends string,
  const Protocol extends string,
  const OAuth extends boolean,
>(metadata: {
  protocol: Protocol
  oauth: OAuth
  planBased?: boolean
  credentials?: ProviderCredentials
  descriptor: ProviderDescriptor<Id>
}) {
  const credentials: ProviderCredentials | undefined =
    metadata.credentials
    ?? (metadata.oauth ? { primaryKey: "accessToken" } : undefined)
  return {
    ...metadata,
    credentials,
  }
}

/** Reject ambiguous registration rather than silently replacing a contribution. */
export function createProviderMetadataCatalog<
  Entry extends {
    descriptor: ProviderDescriptor<string>
    protocol: string
    oauth: boolean
    planBased?: boolean
  },
>(entries: ReadonlyArray<Entry>) {
  const ids = new Set<string>()
  for (const entry of entries) {
    const id = entry.descriptor.id
    if (ids.has(id)) throw new Error(`Duplicate provider metadata: ${id}`)
    ids.add(id)
  }
  return Object.fromEntries(
    entries.map((entry) => [entry.descriptor.id, entry]),
  ) as {
    [Id in Entry["descriptor"]["id"]]: Extract<
      Entry,
      { descriptor: { id: Id } }
    >
  }
}
