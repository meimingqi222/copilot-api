/**
 * Admin API: connection balance.
 *
 * A balance is the money side of a connection — what is left on a prepaid key
 * or an account wallet — as opposed to the quota subsystem's window shares.
 * It is read on demand and stored on the connection, so the dashboard can show
 * the last known amount after a restart.
 *
 * Everything here is forgiving by design: a vendor with no balance endpoint, a
 * relay that answers with a non-2xx, or a body that carries no number all end
 * as `{ balance: null }`. An absent balance is a state, not a failure.
 */

import { Hono } from "hono"

import { fetchBalance, resolveBalanceSource } from "~/lib/balance"
import type { BalanceHosts } from "~/lib/balance"
import { logger } from "~/lib/logger"
import {
  getConnectionCredentialExtras,
  getConnectionSettings,
  getMutableProviderConnection,
  getProviderConnection,
  persistProviderConnections,
} from "~/lib/provider-connections"
import type { ProviderConnection } from "~/lib/provider-connections"
import {
  getConnectionBalance,
  setConnectionBalance,
} from "~/lib/provider-connections/connection-metadata"

export const balanceApiRoutes = new Hono()

/** How long a vendor is given to answer before the probe is abandoned. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * The hosts this connection may be pointed at. A connection carries a single
 * base URL, so every protocol slot points at it and vendor detection sees the
 * same host whichever endpoint the connection's models use.
 */
function connectionHosts(conn: ProviderConnection): BalanceHosts {
  return {
    chat: conn.baseUrl,
    responses: conn.baseUrl,
    anthropic: conn.baseUrl,
  }
}

/**
 * A balance field the user configured on the connection. Credential extras win
 * over settings (extras is the newer home; settings is the legacy one), and a
 * blank value counts as unset.
 */
function connectionBalanceField(
  conn: ProviderConnection,
  key: string,
): string | undefined {
  for (const value of [
    getConnectionCredentialExtras(conn)?.[key],
    getConnectionSettings(conn)?.[key],
  ]) {
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

/**
 * Read the connection's balance from its vendor and remember it.
 *
 * The key sent along is the connection's first credential, which is what a
 * wallet endpoint usually authenticates with; a source carrying its own token
 * ignores it (see the balance subsystem).
 */
balanceApiRoutes.post("/probe", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    connectionId?: unknown
  }
  const connectionId =
    typeof body.connectionId === "string" ? body.connectionId.trim() : ""
  if (!connectionId) {
    return c.json({ error: "connectionId is required." }, 400)
  }

  const conn = getProviderConnection(connectionId)
  if (!conn) {
    return c.json({ error: "Connection not found." }, 404)
  }

  const source = resolveBalanceSource({
    hosts: connectionHosts(conn),
    balanceUrl: connectionBalanceField(conn, "balanceUrl"),
    balancePath: connectionBalanceField(conn, "balancePath"),
    balanceToken: connectionBalanceField(conn, "balanceToken"),
  })
  if (!source) {
    // No explicit balance URL and no known vendor behind this host.
    return c.json({ balance: null })
  }

  const result = await fetchBalance(
    source,
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
    conn.credentials[0]?.value,
  )
  if (!result) {
    return c.json({ balance: null })
  }

  const mutable = getMutableProviderConnection(connectionId)
  if (!mutable) {
    return c.json({ balance: null })
  }
  setConnectionBalance(mutable, result)
  await persistProviderConnections()
  logger.info(
    `Balance read for connection "${mutable.name}": ${result.display}`,
  )

  return c.json({ balance: getConnectionBalance(mutable) ?? null })
})

/** The balance stored on a connection, if any was ever read. */
balanceApiRoutes.get("/:connectionId", (c) => {
  const conn = getProviderConnection(c.req.param("connectionId"))
  if (!conn) {
    return c.json({ error: "Connection not found." }, 404)
  }
  return c.json({ balance: getConnectionBalance(conn) ?? null })
})
