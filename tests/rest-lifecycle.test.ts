/**
 * Rest lifecycle: the registry must actually govern routing, and the rest must
 * be liftable by hand.
 *
 * A rest is read by the credential-availability path (a sitting-out credential
 * is skipped like a cooldown), a held `verify` refusal is answered from memory
 * without another upstream call, and the admin router can list and lift a rest.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { Hono } from "hono"

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { ProviderAdmission } from "~/lib/request-admission"

import { HTTPError } from "~/lib/error"
import {
  isCredentialAvailable,
  __resetProviderConnectionsForTest,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import {
  clearRestRegistryForTest,
  listRests,
  recordRest,
  unrest,
} from "~/lib/route-target"
import { restsApiRoutes } from "~/routes/admin/api/rests"
import { executeWithFailover } from "~/services/dispatch/failover"

import { setTestConnections } from "./helpers/set-connections"

const REST_MS = 30 * 60_000

const app = new Hono().route("/rests", restsApiRoutes)

function credential(id: string): ApiCredential {
  return {
    id,
    authMode: "bearer",
    value: "sk-test",
    enabled: true,
    priority: 0,
    status: "ready",
    createdAt: Date.now(),
  }
}

function target(credentialId: string): RouteTarget {
  return {
    connectionId: "conn-1",
    connectionName: "conn-1",
    protocol: "openai-compatible",
    credentialId,
    publicModelId: "test-model",
    upstreamModelId: "test-model",
    endpoint: "chat",
    connectionPriority: 0,
    connectionWeight: 1,
    credentialPriority: 0,
    credentialWeight: 1,
  }
}

function admission(cred: ApiCredential): ProviderAdmission {
  const connection: ProviderConnection = {
    id: "conn-1",
    name: "conn-1",
    protocol: "openai-compatible",
    baseUrl: "https://example.test",
    enabled: true,
    priority: 0,
    credentials: [cred],
    createdAt: Date.now(),
  }
  return {
    target: target(cred.id),
    connection,
    credential: cred,
    initiator: "user",
  }
}

beforeEach(() => {
  clearRestRegistryForTest()
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
})

afterEach(() => {
  clearRestRegistryForTest()
  __resetProviderConnectionsForTest()
  setTestConnections([])
  resetAdaptiveRateLimiterForTest()
})

describe("rest lifecycle: routing", () => {
  test("a rested credential is skipped by availability", () => {
    const cred = credential("rest-cred")
    expect(isCredentialAvailable(cred)).toBe(true)

    recordRest({
      credentialId: cred.id,
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + REST_MS,
    })
    expect(isCredentialAvailable(cred)).toBe(false)
  })

  test("unrest lifts the rest and the credential is routable again", () => {
    const cred = credential("rest-cred")
    const info = recordRest({
      credentialId: cred.id,
      reason: "credit",
      by: "credit",
      untilMs: Date.now() + REST_MS,
    })
    expect(isCredentialAvailable(cred)).toBe(false)

    expect(unrest(info.key as string)).toBe(true)
    expect(isCredentialAvailable(cred)).toBe(true)
  })

  test("a verify-held credential answers from memory, with no upstream call", async () => {
    const cred = credential("verify-cred")
    const held = JSON.stringify({
      error: { message: "VALIDATION_REQUIRED" },
    })
    recordRest({
      credentialId: cred.id,
      reason: "verify",
      by: "verify",
      untilMs: Date.now() + REST_MS,
      said: held,
    })

    let upstreamCalls = 0
    const error = await executeWithFailover({
      payload: { model: "test-model" },
      admission: admission(cred),
      routeKind: "chat",
      execute: () => {
        upstreamCalls++
        return Promise.resolve("served")
      },
    }).catch((e: unknown) => e)

    expect(upstreamCalls).toBe(0)
    expect(error).toBeInstanceOf(HTTPError)
    expect((error as HTTPError).response.status).toBe(403)
    expect((error as HTTPError).responseBody).toBe(held)
  })
})

describe("rest lifecycle: admin API", () => {
  test("GET lists the live rests", async () => {
    const info = recordRest({
      credentialId: "admin-cred",
      model: "test-model",
      reason: "quota",
      by: "resets",
      untilMs: Date.now() + REST_MS,
    })

    const response = await app.request("/rests")
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      rests: Array<{ key: string; credentialId: string; reason: string }>
    }
    expect(payload.rests).toHaveLength(1)
    expect(payload.rests[0]?.key).toBe(info.key as string)
    expect(payload.rests[0]?.credentialId).toBe("admin-cred")
    expect(payload.rests[0]?.reason).toBe("quota")
  })

  test("DELETE lifts a rest by its (URL-encoded) key", async () => {
    const info = recordRest({
      credentialId: "admin-cred",
      model: "test-model",
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + REST_MS,
    })
    expect(listRests()).toHaveLength(1)

    const response = await app.request(
      `/rests/${encodeURIComponent(info.key as string)}`,
      { method: "DELETE" },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(listRests()).toHaveLength(0)
  })

  test("DELETE reports false for a key that holds no rest", async () => {
    const response = await app.request("/rests/nobody-here", {
      method: "DELETE",
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false })
  })
})
