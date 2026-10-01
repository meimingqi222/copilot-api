/**
 * Balance subsystem entry point.
 *
 * Resolution order mirrors how a connection is configured: an explicit
 * balance URL wins, otherwise the vendor is inferred from its hosts. Fetching
 * is deliberately forgiving — a missing or malformed balance is not an error,
 * it is an absent field.
 */

import type { BalanceResult, BalanceSource } from "~/lib/balance/types"
import type { BalanceHosts } from "~/lib/balance/sources"

import { customBalanceSource, knownBalanceSource } from "~/lib/balance/sources"

export type { BalanceHosts } from "~/lib/balance/sources"
export type { BalanceResult, BalanceSource } from "~/lib/balance/types"
export {
  currencySign,
  money,
  numberFrom,
  readDottedPath,
} from "~/lib/balance/parse"
export {
  customBalanceSource,
  knownBalanceSource,
  normalizeHost,
  takesBalanceToken,
} from "~/lib/balance/sources"

export interface ResolveBalanceSourceInput {
  hosts?: BalanceHosts
  /** A user-named balance URL; wins over the known host. */
  balanceUrl?: string
  /** Dotted path read for a custom URL. */
  balancePath?: string
  /** Dedicated token for a custom URL or an aihubmix account. */
  balanceToken?: string
}

/** Pick the balance source for a connection: custom URL first, else the host. */
export function resolveBalanceSource(
  input: ResolveBalanceSourceInput,
): BalanceSource | undefined {
  const url = input.balanceUrl?.trim()
  if (url) {
    return customBalanceSource({
      url,
      path: input.balancePath,
      token: input.balanceToken,
    })
  }
  return knownBalanceSource(input.hosts ?? {}, input.balanceToken)
}

/** The fetch signature `fetchBalance` uses; swappable for tests. */
export type BalanceFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

const defaultFetcher: BalanceFetcher = (input, init) =>
  globalThis.fetch(input, init)

let activeFetcher: BalanceFetcher = defaultFetcher

/** Test seam: replace the HTTP client used by `fetchBalance`. */
export function setBalanceFetcher(fetcher?: BalanceFetcher): void {
  activeFetcher = fetcher ?? defaultFetcher
}

/**
 * GET a balance source and read it. Returns undefined on a non-2xx status, a
 * transport error or an unreadable body — it never throws.
 *
 * A source token is sent as the whole `Authorization` header (some relays
 * expect a raw key); without one the passed key is sent as `Bearer <key>`.
 */
export async function fetchBalance(
  source: BalanceSource,
  signal?: AbortSignal,
  key?: string,
): Promise<BalanceResult | undefined> {
  const headers: Record<string, string> = { accept: "application/json" }
  const credential = source.token ?? key
  if (credential) {
    headers.authorization = source.token ? source.token : `Bearer ${credential}`
  }
  try {
    const response = await activeFetcher(source.url, {
      method: "GET",
      headers,
      signal,
    })
    if (!response.ok) return undefined
    const body = await response.text()
    return source.read(body)
  } catch {
    return undefined
  }
}
