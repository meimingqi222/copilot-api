import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type {
  RouteTarget,
  ProviderConnection,
  ApiCredential,
} from "~/lib/provider-connections"
import type { ConnectionAdmission } from "~/lib/request-admission"

import { HTTPError } from "~/lib/error"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { executeWithFailover } from "~/services/dispatch/failover"

afterEach(() => {
  resetAdaptiveRateLimiterForTest()
  state.accounts = []
  state.activeAccountIndex = 0
})

beforeEach(() => {
  resetAdaptiveRateLimiterForTest()
  state.accounts = []
  state.activeAccountIndex = 0
})

describe("dispatch-failover", () => {
  test("executeWithFailover tries next target on HTTPError failover eligible status", async () => {
    const payload = { model: "test-model" }

    const target: RouteTarget = {
      connectionId: "conn-1",
      connectionName: "conn-1",
      protocol: "openai-compatible",
      credentialId: "cred-1",
      publicModelId: "test-model",
      upstreamModelId: "upstream-model-1",
      endpoint: "chat",
      connectionPriority: 0,
      connectionWeight: 1,
      credentialPriority: 0,
      credentialWeight: 1,
    }

    const credential: ApiCredential = {
      id: "cred-1",
      authMode: "bearer",
      value: "cred-value-1",
      enabled: true,
      priority: 0,
      status: "ready",
      createdAt: Date.now(),
    }

    const connection: ProviderConnection = {
      id: "conn-1",
      name: "conn-1",
      protocol: "openai-compatible",
      baseUrl: "https://api.openai.com",
      enabled: true,
      priority: 0,
      credentials: [credential],
      createdAt: Date.now(),
    }

    const admission: ConnectionAdmission = {
      kind: "connection",
      target,
      connection,
      credential,
      initiator: "user",
    }

    let executeCount = 0

    try {
      await executeWithFailover({
        payload,
        admission,
        routeKind: "chat",
        execute: (_adapter, currentTarget) => {
          executeCount++
          if (currentTarget.connectionId === "conn-1") {
            throw new HTTPError(
              "Bad Gateway",
              new Response("Bad Gateway", { status: 502 }),
            )
          }
          return Promise.resolve("success")
        },
      })
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPError)
      expect((err as HTTPError).response.status).toBe(502)
    }

    expect(executeCount).toBe(1)
  })
})
