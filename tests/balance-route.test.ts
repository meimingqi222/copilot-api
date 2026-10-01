/**
 * Admin balance route tests.
 *
 * A probe reads a connection's vendor wallet, stores the normalized result on
 * the connection, and reports an absent balance — never an error — when the
 * vendor has nothing readable. HTTP is stubbed through the balance subsystem's
 * fetch seam, so nothing here touches the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { ProviderConnection } from "~/lib/provider-connections"

import { setBalanceFetcher } from "~/lib/balance"
import {
  __resetProviderConnectionsForTest,
  ensureConnectionMetadata,
  getProviderConnection,
  setConnectionCredentialExtra,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { getConnectionBalance } from "~/lib/provider-connections/connection-metadata"
import { balanceApiRoutes } from "~/routes/admin/api/balance"

const app = new Hono().route("/balance", balanceApiRoutes)

interface StoredBalance {
  amount: number
  currency: string
  display: string
  at: number
}

interface BalancePayload {
  balance: StoredBalance | null
}

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

async function probe(connectionId: string): Promise<Response> {
  return app.request("/balance/probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId }),
  })
}

/** The live connection by id; the fixtures always register it. */
function connectionOrThrow(id: string): ProviderConnection {
  const conn = getProviderConnection(id)
  if (!conn) throw new Error(`connection "${id}" is not registered`)
  return conn
}

beforeEach(() => {
  __resetProviderConnectionsForTest()
})

afterEach(() => {
  setBalanceFetcher(undefined)
  __resetProviderConnectionsForTest()
})

describe("admin balance route", () => {
  test("probes a known vendor and stores the balance on the connection", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    setBalanceFetcher((input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: "CNY", total_balance: "110.25" }],
          }),
          { status: 200 },
        ),
      )
    })
    upsertProviderConnection(testConnection("deepseek-main"))

    const response = await probe("deepseek-main")
    expect(response.status).toBe(200)
    const payload = (await response.json()) as BalancePayload

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://api.deepseek.com/user/balance")
    // The connection's own key is sent as a bearer token when the source has
    // no token of its own.
    expect(requests[0]?.authorization).toBe("Bearer sk-deepseek")

    expect(payload.balance?.amount).toBe(110.25)
    expect(payload.balance?.currency).toBe("CNY")
    // The yuan symbol, formatted by the balance subsystem.
    expect(payload.balance?.display).toBe("\u00A5110.25")
    expect(typeof payload.balance?.at).toBe("number")

    // Stored on the connection, minus the vendor's raw body.
    const stored = getConnectionBalance(connectionOrThrow("deepseek-main"))
    expect(stored).toEqual(payload.balance as StoredBalance)
    expect(JSON.stringify(stored)).not.toContain("balance_infos")
  })

  test("a configured balance URL wins over the host and carries its own token", async () => {
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

    const response = await probe("relay")
    expect(response.status).toBe(200)
    const payload = (await response.json()) as BalancePayload

    expect(requests[0]?.url).toBe("https://relay.example.com/api/user/self")
    // A source token is the whole Authorization header, not a bearer prefix.
    expect(requests[0]?.authorization).toBe("bt-1")
    // new-api relays price a dollar as 500000 quota units.
    expect(payload.balance?.amount).toBe(0.5)
    expect(payload.balance?.currency).toBe("USD")
    expect(payload.balance?.display).toBe("$0.50")
  })

  test("an upstream failure is an empty balance, not an error", async () => {
    upsertProviderConnection(testConnection("deepseek-main"))

    setBalanceFetcher(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    )
    const httpMiss = await probe("deepseek-main")
    expect(httpMiss.status).toBe(200)
    expect(((await httpMiss.json()) as BalancePayload).balance).toBeNull()

    setBalanceFetcher(() => Promise.reject(new Error("ECONNREFUSED")))
    const transportMiss = await probe("deepseek-main")
    expect(transportMiss.status).toBe(200)
    expect(((await transportMiss.json()) as BalancePayload).balance).toBeNull()

    // A miss leaves whatever was stored alone.
    expect(
      getConnectionBalance(connectionOrThrow("deepseek-main")),
    ).toBeUndefined()
  })

  test("an unknown host with no configured URL is never fetched", async () => {
    let called = false
    setBalanceFetcher(() => {
      called = true
      return Promise.resolve(new Response("{}", { status: 200 }))
    })
    upsertProviderConnection(
      testConnection("plain", { baseUrl: "https://api.example.com/v1" }),
    )

    const response = await probe("plain")
    expect(response.status).toBe(200)
    expect(((await response.json()) as BalancePayload).balance).toBeNull()
    expect(called).toBe(false)
  })

  test("rejects a missing connectionId and an unknown connection", async () => {
    const missing = await app.request("/balance/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(missing.status).toBe(400)

    const unknown = await probe("nope")
    expect(unknown.status).toBe(404)
  })

  test("GET reports the stored balance, or null before any probe", async () => {
    upsertProviderConnection(testConnection("deepseek-main"))

    const before = await app.request("/balance/deepseek-main")
    expect(before.status).toBe(200)
    expect(((await before.json()) as BalancePayload).balance).toBeNull()

    setBalanceFetcher(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            balance_infos: [{ currency: "CNY", total_balance: "7.5" }],
          }),
          { status: 200 },
        ),
      ),
    )
    await probe("deepseek-main")

    const after = await app.request("/balance/deepseek-main")
    expect(after.status).toBe(200)
    const payload = (await after.json()) as BalancePayload
    expect(payload.balance?.amount).toBe(7.5)
    expect(payload.balance?.display).toBe("\u00A57.50")

    const missing = await app.request("/balance/nope")
    expect(missing.status).toBe(404)
  })
})
