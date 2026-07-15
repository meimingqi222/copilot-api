import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"
import type {
  RouteTarget,
  ProviderConnection,
  ApiCredential,
} from "~/lib/provider-connections"
import type { ProviderAdmission } from "~/lib/request-admission"

import { HTTPError } from "~/lib/error"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { executeWithFailover } from "~/services/dispatch/failover"

import { setTestAccounts } from "./helpers/set-accounts"

afterEach(() => {
  resetAdaptiveRateLimiterForTest()
  setTestAccounts([])
  state.activeAccountIndex = 0
})

beforeEach(() => {
  resetAdaptiveRateLimiterForTest()
  setTestAccounts([])
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

    const admission: ProviderAdmission = {
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

  test("marks account quota exhausted on usage_limit_reached", async () => {
    const account: Account = {
      id: "oauth-1",
      label: "codex-account",
      provider: "codex",
      credentials: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      enabled: true,
      priority: 0,
      quotaState: "available",
      createdAt: Date.now(),
    }
    setTestAccounts([account])

    const target: RouteTarget = {
      connectionId: account.id,
      connectionName: account.label,
      protocol: "codex-native",
      credentialId: account.id,
      publicModelId: "gpt-5",
      upstreamModelId: "gpt-5",
      endpoint: "chat",
      connectionPriority: 0,
      connectionWeight: 1,
      credentialPriority: 0,
      credentialWeight: 1,
    }

    const credential: ApiCredential = {
      id: account.id,
      authMode: "bearer",
      value: "access-token",
      enabled: true,
      priority: 0,
      status: "ready",
      createdAt: Date.now(),
    }

    const connection: ProviderConnection = {
      id: account.id,
      name: account.label,
      protocol: "codex-native",
      baseUrl: "https://api.openai.com",
      enabled: true,
      priority: 0,
      credentials: [credential],
      createdAt: Date.now(),
    }

    const admission: ProviderAdmission = {
      target,
      connection,
      credential,
      account,
      initiator: "user",
    }

    const usageLimitBody = JSON.stringify({
      error: {
        type: "usage_limit_reached",
        resets_in_seconds: 3600,
      },
    })

    try {
      await executeWithFailover({
        payload: { model: "gpt-5" },
        admission,
        routeKind: "chat",
        execute: () => {
          throw new HTTPError(
            "usage limit",
            new Response(usageLimitBody, { status: 429 }),
            usageLimitBody,
          )
        },
      })
      expect.unreachable("expected usage_limit_reached to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
    }

    expect(state.accounts[0]?.quotaState).toBe("exhausted")
    expect(state.accounts[0]?.isExhausted).toBe(true)
  })
})
