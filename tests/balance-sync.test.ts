/**
 * Balance sync tests.
 *
 * A balance read on the scheduler's behalf is stored on the connection; a
 * wallet read at or below zero takes the connection out of routing through the
 * out-of-credit path, and a wallet that comes back positive hands it back.
 * HTTP is stubbed through the balance subsystem's fetch seam, so nothing here
 * touches the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { setBalanceFetcher } from "~/lib/balance"
import {
  __resetBalanceGateForTest,
  applyBalanceGate,
  connectionBalanceField,
  resolveConnectionBalanceSource,
  syncConnectionBalance,
} from "~/lib/balance/sync"
import {
  __resetProviderConnectionsForTest,
  ensureConnectionMetadata,
  getProviderConnection,
  isCredentialAvailable,
  refreshConnectionAvailability,
  setConnectionCredentialExtra,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { getConnectionBalance } from "~/lib/provider-connections/connection-metadata"
import { __resetBalanceSyncForTest, syncBalances } from "~/lib/quota/scheduler"
import { buildRouteTargets } from "~/lib/route-target"

function testConnection(
  id: string,
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    enabled: true,
    priority: 1,
    models: [
      {
        publicId: "deepseek-chat",
        upstreamId: "deepseek-chat",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
    credentials: [
      {
        id: `${id}-cred`,
        authMode: "bearer",
        value: "sk-deepseek",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
    ],
    createdAt: Date.now(),
    ...overrides,
  }
}

/** A DeepSeek-style wallet body carrying `amount` yuan. */
function wallet(amount: string): Response {
  return new Response(
    JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: amount }],
    }),
    { status: 200 },
  )
}

function liveConnection(id: string): ProviderConnection {
  const conn = getProviderConnection(id)
  if (!conn) throw new Error(`connection "${id}" is not registered`)
  return conn
}

beforeEach(() => {
  __resetProviderConnectionsForTest()
  __resetBalanceGateForTest()
  __resetBalanceSyncForTest()
})

afterEach(() => {
  setBalanceFetcher(undefined)
  __resetProviderConnectionsForTest()
  __resetBalanceGateForTest()
  __resetBalanceSyncForTest()
})

describe("syncConnectionBalance", () => {
  test("stores what the wallet answered on the connection", async () => {
    upsertProviderConnection(testConnection("deepseek-main"))
    setBalanceFetcher(() => Promise.resolve(wallet("42.50")))

    const stored = await syncConnectionBalance(liveConnection("deepseek-main"))

    expect(stored?.amount).toBe(42.5)
    expect(stored?.currency).toBe("CNY")
    expect(stored?.display).toBe("\u00A542.50")
    expect(typeof stored?.at).toBe("number")
    expect(getConnectionBalance(liveConnection("deepseek-main"))).toEqual(
      stored as NonNullable<typeof stored>,
    )
  })

  test("resolves the same source the admin probe does, token included", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    setBalanceFetcher((input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return Promise.resolve(
        new Response(JSON.stringify({ data: { quota: 250_000 } }), {
          status: 200,
        }),
      )
    })

    const conn = testConnection("relay", {
      baseUrl: "https://relay.example.com/v1",
    })
    ensureConnectionMetadata(conn)
    setConnectionCredentialExtra(
      conn,
      "balanceUrl",
      "https://relay.example.com/api/user/self",
    )
    setConnectionCredentialExtra(conn, "balancePath", "data.quota")
    setConnectionCredentialExtra(conn, "balanceToken", "bt-1")
    upsertProviderConnection(conn)

    expect(connectionBalanceField(conn, "balanceToken")).toBe("bt-1")
    expect(resolveConnectionBalanceSource(conn)?.url).toBe(
      "https://relay.example.com/api/user/self",
    )

    const stored = await syncConnectionBalance(conn)

    expect(requests).toHaveLength(1)
    // A source token is the whole Authorization header, not a bearer prefix.
    expect(requests[0]?.authorization).toBe("bt-1")
    expect(stored?.amount).toBe(0.5)
    expect(stored?.display).toBe("$0.50")
  })

  test("a connection with no known source is never fetched", async () => {
    let called = false
    setBalanceFetcher(() => {
      called = true
      return Promise.resolve(wallet("1.00"))
    })
    const conn = testConnection("plain", {
      baseUrl: "https://api.example.com/v1",
    })
    upsertProviderConnection(conn)

    expect(resolveConnectionBalanceSource(conn)).toBeUndefined()
    expect(await syncConnectionBalance(conn)).toBeUndefined()
    // The tick skips it too: there is nothing to read.
    expect(await syncBalances()).toBe(0)
    expect(called).toBe(false)
  })

  test("a miss leaves the stored balance, and the gate it drives, alone", async () => {
    const conn = testConnection("deepseek-main")
    upsertProviderConnection(conn)
    setBalanceFetcher(() => Promise.resolve(wallet("5.00")))
    await syncConnectionBalance(conn)
    expect(applyBalanceGate(conn)).toEqual({ gated: false, changed: false })

    setBalanceFetcher(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    )
    expect(await syncConnectionBalance(conn)).toBeUndefined()
    expect(getConnectionBalance(conn)?.amount).toBe(5)
    expect(applyBalanceGate(conn)).toEqual({ gated: false, changed: false })
  })
})

describe("balance gate", () => {
  test("a depleted balance is skipped, and a top-up re-activates", async () => {
    const conn = testConnection("deepseek-main")
    upsertProviderConnection(conn)

    setBalanceFetcher(() => Promise.resolve(wallet("0")))
    await syncConnectionBalance(conn)
    expect(applyBalanceGate(conn)).toEqual({ gated: true, changed: true })
    // Re-confirming on the next tick is not a transition.
    expect(applyBalanceGate(conn)).toEqual({ gated: true, changed: false })

    // The request path refreshes expired states before it routes; the gate has
    // to survive that.
    const credential = liveConnection("deepseek-main").credentials[0]
    refreshConnectionAvailability(conn)
    expect(isCredentialAvailable(credential!)).toBe(false)
    expect(buildRouteTargets({ connectionId: "deepseek-main" })).toHaveLength(0)

    setBalanceFetcher(() => Promise.resolve(wallet("10.00")))
    await syncConnectionBalance(conn)
    expect(applyBalanceGate(conn)).toEqual({ gated: false, changed: true })

    refreshConnectionAvailability(conn)
    expect(
      isCredentialAvailable(liveConnection("deepseek-main").credentials[0]!),
    ).toBe(true)
    expect(
      buildRouteTargets({ connectionId: "deepseek-main" }).length,
    ).toBeGreaterThan(0)
  })

  test("a credential already dead on auth is not mistaken for broke", () => {
    const conn = testConnection("deepseek-main")
    pushBalance(conn, 0)
    const credential = conn.credentials[0]!
    credential.status = "auth_error"
    upsertProviderConnection(conn)

    expect(applyBalanceGate(conn)).toEqual({ gated: false, changed: false })
    expect(credential.status).toBe("auth_error")
  })
})

describe("balance sync tick", () => {
  test("reads each wallet once per window", async () => {
    let calls = 0
    setBalanceFetcher(() => {
      calls += 1
      return Promise.resolve(wallet("1.00"))
    })
    upsertProviderConnection(testConnection("deepseek-main"))

    const now = Date.now()
    expect(await syncBalances(now)).toBe(1)
    expect(calls).toBe(1)

    expect(await syncBalances(now + 1000)).toBe(0)
    expect(calls).toBe(1)

    // Past the window, the wallet is read again.
    expect(await syncBalances(now + 6 * 60_000)).toBe(1)
    expect(calls).toBe(2)
  })
})

/** Store a balance on a connection without going through the fetch seam. */
function pushBalance(conn: ProviderConnection, amount: number): void {
  const metadata = ensureConnectionMetadata(conn)
  metadata.balance = {
    amount,
    currency: "CNY",
    display: `\u00A5${amount.toFixed(2)}`,
    at: Date.now(),
  }
}
