import type { ProviderConnection } from "~/lib/provider-connections"

import snapshot from "~/lib/models-dev/snapshot.json"
import { getModelsDevCatalog } from "~/lib/models-dev/client"
import {
  connectionProvider,
  isAccountManagedConnection,
} from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"

/** Match the billing endpoint, not the compatible wire protocol or model author. */
export function connectionPricingProvider(
  connection: ProviderConnection,
): string {
  if (isAccountManagedConnection(connection))
    return connectionProvider(connection)
  const catalog = getModelsDevCatalog() ?? snapshot.catalog
  const matches: Array<{ id: string; length: number }> = []
  try {
    const base = new URL(connection.baseUrl)
    for (const [id, provider] of Object.entries(catalog ?? {})) {
      if (!provider.api) continue
      let api: URL
      try {
        api = new URL(provider.api)
      } catch {
        continue
      }
      const prefix = api.pathname.replace(/\/$/, "")
      const path = base.pathname.replace(/\/$/, "")
      if (
        api.origin === base.origin
        && (path === prefix || path.startsWith(`${prefix}/`))
      ) {
        matches.push({ id, length: prefix.length })
      }
    }
  } catch {
    return "unmatched-channel"
  }
  matches.sort((a, b) => b.length - a.length)
  const best = matches[0]
  if (!best || matches.filter((m) => m.length === best.length).length !== 1)
    return "unmatched-channel"
  return best.id
}

export function resolveConnectionModelPricing(
  connection: ProviderConnection,
  publicModel: string,
  upstreamModel?: string,
) {
  // A deliberate public override (including free) wins. Automatic lookup uses
  // the model actually sent upstream, so renamed public IDs cannot misprice it.
  const manual = statsStore.getManualModelPricing(publicModel)
  if (manual) return { ...manual, source: "manual" as const }
  const mapping = connection.models?.find((m) => m.publicId === publicModel)
  const native = mapping?.upstreamId ?? upstreamModel ?? publicModel
  return statsStore.resolveModelPricing(
    native,
    connectionPricingProvider(connection),
  )
}
