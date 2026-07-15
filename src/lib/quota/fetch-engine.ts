import type { Account, QuotaSnapshot } from "~/lib/accounts"
import type { OAuthProviderId } from "~/lib/provider-config"

import { isOAuthAccount } from "~/lib/accounts"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"

export interface SimpleQuotaDescriptor {
  provider: OAuthProviderId
  /** Display name used in error messages (e.g. "Claude", "Kimi") */
  displayName: string
  url: string
  headers: Record<string, string>
  /** Parse response body and assemble a QuotaSnapshot; throw on parse failure */
  buildSnapshot(body: string, account: Account): QuotaSnapshot
}

/**
 * Generic quota fetch engine: provider guard → executeUpstreamProxyCall →
 * status check → delegate snapshot assembly to the descriptor.
 */
export async function fetchQuotaByDescriptor(
  account: Account,
  descriptor: SimpleQuotaDescriptor,
  signal?: AbortSignal,
): Promise<QuotaSnapshot> {
  const { provider, displayName } = descriptor
  if (!isOAuthAccount(account) || account.provider !== provider) {
    throw new Error(
      `fetch${displayName}Quota requires a ${displayName} OAuth account`,
    )
  }

  const response = await executeUpstreamProxyCall(account, {
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

  return descriptor.buildSnapshot(response.body, account)
}
