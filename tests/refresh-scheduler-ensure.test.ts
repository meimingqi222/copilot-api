/**
 * The shared token refresh scheduler's request-time contract.
 *
 * `ensureAccessToken` is what adapters call before signing an upstream request.
 * The caller passes the credential its route target admitted on, so the token
 * that comes back must belong to *that* credential — a multi-credential
 * connection whose list was rotated must not get the first credential's token.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { createTokenRefreshScheduler } from "~/services/auth/refresh-scheduler"

function connectionWithTwoCredentials(): ProviderConnection {
  const now = Date.now()
  return {
    id: "multi-cred",
    name: "Multi",
    protocol: "codebuddy-native",
    baseUrl: "https://upstream.test",
    enabled: true,
    priority: 0,
    weight: 1,
    createdAt: now,
    credentials: [
      {
        id: "cred-a",
        authMode: "bearer",
        value: "token-a-old",
        enabled: true,
        status: "ready",
        createdAt: now,
      },
      {
        id: "cred-b",
        authMode: "bearer",
        value: "token-b-old",
        enabled: true,
        status: "ready",
        createdAt: now,
      },
    ],
    models: [],
  }
}

describe("token refresh scheduler ensureAccessToken", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
  })

  afterEach(() => {
    __resetProviderConnectionsForTest()
  })

  test("returns the refreshed token of the credential the caller asked for", async () => {
    const connection = connectionWithTwoCredentials()
    upsertProviderConnection(connection)

    const scheduler = createTokenRefreshScheduler({
      scope: "test",
      jobLabel: "Test token refresh",
      protocol: "codebuddy-native",
      // A refresh rotates every credential's value in place.
      refresh: (conn) => {
        for (const credential of conn.credentials) {
          credential.value = `${credential.id}-fresh`
        }
        return Promise.resolve(true)
      },
      // Always inside the refresh window.
      expiryMs: () => Date.now(),
      canSchedule: () => true,
      canRefresh: () => true,
      requiresExpiry: false,
      ensure: { gate: "argument", result: "by-id" },
    })

    const live = connection
    const second = live.credentials[1]
    const token = await scheduler.ensureAccessToken(live, second!)

    // "first" would have handed back cred-a's token, signing the request with
    // an identity the route target did not admit.
    expect(token).toBe("cred-b-fresh")
  })

  test("keeps the caller's value when the refresh did not succeed", async () => {
    const connection = connectionWithTwoCredentials()
    upsertProviderConnection(connection)

    const scheduler = createTokenRefreshScheduler({
      scope: "test",
      jobLabel: "Test token refresh",
      protocol: "codebuddy-native",
      refresh: () => Promise.resolve(false),
      expiryMs: () => Date.now(),
      canSchedule: () => true,
      canRefresh: () => true,
      requiresExpiry: false,
      ensure: { gate: "argument", result: "by-id" },
    })

    const second = connection.credentials[1]
    const token = await scheduler.ensureAccessToken(connection, second!)
    expect(token).toBe("token-b-old")
  })
})
