import type { QuotaSnapshot } from "~/lib/legacy-accounts"
import type { OAuthProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"

export interface SimpleQuotaDescriptor {
  provider: OAuthProviderId
  /** Display name used in error messages (e.g. "Claude", "Kimi") */
  displayName: string
  url: string
  headers: Record<string, string>
  /** Parse response body and assemble a QuotaSnapshot; throw on parse failure */
  buildSnapshot(body: string, connection: ProviderConnection): QuotaSnapshot
}

/**
 * Generic quota fetch engine: provider guard → executeUpstreamProxyCall →
 * status check → delegate snapshot assembly to the descriptor.
 */
export async function fetchQuotaByDescriptor(
  connection: ProviderConnection,
  descriptor: SimpleQuotaDescriptor,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  const { provider, displayName } = descriptor
  if (getConnectionProvider(connection) !== provider) {
    throw new Error(
      `fetch${displayName}Quota requires a ${displayName} OAuth connection`,
    )
  }

  const response = await executeUpstreamProxyCall(connection, {
    method: "GET",
    url: descriptor.url,
    headers: { ...descriptor.headers },
    signal,
  })

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `${displayName} quota request failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
    )
  }

  return descriptor.buildSnapshot(response.body, connection)
}
