/**
 * Balance sync: read a connection's wallet on a schedule, and gate routing on it.
 *
 * The admin probe reads a balance when someone asks; routing needs the same
 * answer without a human clicking, and the request path must stay free of
 * network work. Everything HTTP lives here and is driven by the quota
 * scheduler's periodic tick; the request path only ever reads what this
 * stored.
 *
 * Resolution mirrors how a connection is configured (an explicit balance URL
 * wins, otherwise the vendor is inferred from its hosts) — the same resolution
 * the admin probe uses, factored out here so there is one definition.
 *
 * A connection whose last read sits at or below zero has no money left, so it
 * sits out until a later read comes back positive: it takes the same
 * quota_exhausted state (and, through it, the same credential rest) the
 * failover path applies when a vendor answers `insufficient balance`.
 */

import type { BalanceHosts, BalanceSource } from "~/lib/balance"
import type { ProviderConnection } from "~/lib/provider-connections"

import { fetchBalance, resolveBalanceSource } from "~/lib/balance"
import {
  getConnectionCredentialExtras,
  getConnectionSettings,
  markCredentialQuotaExhausted,
  setConnectionQuotaState,
} from "~/lib/provider-connections"
import {
  getConnectionBalance,
  setConnectionBalance,
  type ConnectionBalance,
} from "~/lib/provider-connections/connection-metadata"
import { restDecisionForReason } from "~/lib/route-target/rest-reason"

/**
 * How long a depleted balance keeps a connection out before the next read
 * decides again. It is the out-of-credit rest band: a wallet is topped up by a
 * human, and the periodic tick re-reads long before this lapses.
 */
const BALANCE_GATE_RECOVERY_MS = restDecisionForReason({
  reason: "credit",
  now: 0,
}).restMs

/**
 * The credential ids currently sitting out on a depleted balance. Memory-only:
 * a restart forgets it, the persisted `cooldownUntil` keeps the rest alive
 * until the next read, and only a connection this module put out is taken back
 * in — a credential exhausted by its own vendor is left alone.
 */
const gatedCredentials = new Set<string>()

/**
 * The hosts this connection may be pointed at. A connection carries a single
 * base URL, so every protocol slot points at it and vendor detection sees the
 * same host whichever endpoint the connection's models use.
 */
function connectionBalanceHosts(connection: ProviderConnection): BalanceHosts {
  return {
    chat: connection.baseUrl,
    responses: connection.baseUrl,
    anthropic: connection.baseUrl,
  }
}

/**
 * A balance field the user configured on the connection. Credential extras win
 * over settings (extras is the newer home; settings is the legacy one), and a
 * blank value counts as unset.
 */
export function connectionBalanceField(
  connection: ProviderConnection,
  key: string,
): string | undefined {
  for (const value of [
    getConnectionCredentialExtras(connection)?.[key],
    getConnectionSettings(connection)?.[key],
  ]) {
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

/**
 * Where this connection's balance can be read from — a configured URL first,
 * else the vendor behind its host. Undefined means there is nothing to read,
 * which is a state, not a failure.
 */
export function resolveConnectionBalanceSource(
  connection: ProviderConnection,
): BalanceSource | undefined {
  return resolveBalanceSource({
    hosts: connectionBalanceHosts(connection),
    balanceUrl: connectionBalanceField(connection, "balanceUrl"),
    balancePath: connectionBalanceField(connection, "balancePath"),
    balanceToken: connectionBalanceField(connection, "balanceToken"),
  })
}

/**
 * Read the connection's balance and store it. Returns the stored balance, or
 * undefined when there was no source to read or the vendor answered nothing
 * usable — a miss leaves the previously stored balance (and the gate it
 * drives) untouched.
 *
 * The key sent along is the connection's first credential, which is what a
 * wallet endpoint usually authenticates with; a source carrying its own token
 * ignores it. The caller is responsible for a following
 * `persistProviderConnections()`.
 */
export async function syncConnectionBalance(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<ConnectionBalance | undefined> {
  const source = resolveConnectionBalanceSource(connection)
  if (!source) return undefined

  const result = await fetchBalance(
    source,
    signal,
    connection.credentials[0]?.value,
  )
  if (!result) return undefined

  setConnectionBalance(connection, result)
  return getConnectionBalance(connection)
}

interface BalanceGateResult {
  /** The connection is sitting out on a depleted balance now. */
  gated: boolean
  /** This call moved it — it went out, or came back in. */
  changed: boolean
}

/**
 * Apply the connection's stored balance to routing.
 *
 * A balance at or below zero puts the connection out (the out-of-credit path);
 * a positive one hands back a connection this module put out. A miss — no
 * balance ever read, or a credential already dead on auth — changes nothing.
 */
export function applyBalanceGate(
  connection: ProviderConnection,
): BalanceGateResult {
  const balance = getConnectionBalance(connection)
  const credential = connection.credentials[0]
  if (!balance || !credential) return { gated: false, changed: false }

  if (balance.amount <= 0) {
    // A broken sign-in outranks an empty wallet: leave the reason alone.
    if (credential.status === "auth_error") {
      return { gated: gatedCredentials.has(credential.id), changed: false }
    }
    const wasGated = gatedCredentials.has(credential.id)
    markCredentialQuotaExhausted(
      credential,
      `balance depleted (${balance.display})`,
      BALANCE_GATE_RECOVERY_MS,
    )
    gatedCredentials.add(credential.id)
    return { gated: true, changed: !wasGated }
  }

  if (!gatedCredentials.delete(credential.id)) {
    return { gated: false, changed: false }
  }
  // Topped up: clear the quota lock and its cooldown so the credential is
  // ready for the next request.
  setConnectionQuotaState(connection, "available")
  return { gated: false, changed: true }
}

/** Forget which credentials this module put out (tests). */
export function __resetBalanceGateForTest(): void {
  gatedCredentials.clear()
}
