import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"

/** Keep literal identity types without depending on the assembled provider catalog. */
export function defineProviderMetadata<
  const Id extends string,
  const Protocol extends string,
  const OAuth extends boolean,
>(metadata: {
  protocol: Protocol
  oauth: OAuth
  planBased?: boolean
  descriptor: ProviderDescriptor<Id>
}) {
  return metadata
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
