import { describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { upgradeConnectionV1ToV2 } from "~/lib/provider-connections"

function makeV1Connection(): ProviderConnection {
  return {
    id: "test-1",
    name: "test-conn",
    protocol: "copilot-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
    credentials: [
      {
        id: "test-1",
        authMode: "bearer",
        value: "token",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
        refresherType: "copilot-token",
        context: { githubToken: "ghp_test" },
      },
    ],
    metadata: {
      provider: "copilot",
      quotaState: "ok",
      quotaInfo: {
        fetchedAt: 1000,
        unlimited: false,
        premiumInteractionsRemaining: 50,
      },
      quotaExhaustedAt: 2000,
      exhaustedAt: 2001,
      lastRateLimitReason: "too many requests",
      lastRateLimitAt: 3000,
      cooldownUntil: 4000,
      proxyUrl: "http://proxy.example.com",
      modelPrefix: "prefix-",
      settings: { baseUrl: "https://api.example.com" },
      authStatus: "ready",
      authError: null,
    },
  }
}

describe("upgradeConnectionV1ToV2", () => {
  test("promotes metadata fields to typed connection/credential fields", () => {
    const v1 = makeV1Connection()
    const v2 = upgradeConnectionV1ToV2(v1)

    // credential.quota promoted from metadata.quotaInfo
    expect(v2.credentials[0].quota).toEqual({
      fetchedAt: 1000,
      unlimited: false,
      premiumInteractionsRemaining: 50,
    })

    // credential.exhaustedAt promoted from metadata.quotaExhaustedAt (preferred over exhaustedAt)
    expect(v2.credentials[0].exhaustedAt).toBe(2000)

    // credential.lastRateLimitReason promoted from metadata.lastRateLimitReason
    expect(v2.credentials[0].lastRateLimitReason).toBe("too many requests")

    // connection.proxyUrl promoted from metadata.proxyUrl
    expect(v2.proxyUrl).toBe("http://proxy.example.com")

    // connection.modelPrefix promoted from metadata.modelPrefix
    expect(v2.modelPrefix).toBe("prefix-")
  })

  test("removes promoted metadata keys", () => {
    const v1 = makeV1Connection()
    const v2 = upgradeConnectionV1ToV2(v1)
    const meta = v2.metadata as Record<string, unknown>

    expect(meta.quotaInfo).toBeUndefined()
    expect(meta.quotaExhaustedAt).toBeUndefined()
    expect(meta.exhaustedAt).toBeUndefined()
    expect(meta.lastRateLimitReason).toBeUndefined()
    expect(meta.proxyUrl).toBeUndefined()
    expect(meta.modelPrefix).toBeUndefined()
    expect(meta.cooldownUntil).toBeUndefined()
    expect(meta.lastRateLimitAt).toBeUndefined()
  })

  test("preserves non-promoted metadata keys", () => {
    const v1 = makeV1Connection()
    const v2 = upgradeConnectionV1ToV2(v1)
    const meta = v2.metadata as Record<string, unknown>

    // provider, quotaState, settings, authStatus, authError are derived/stay
    expect(meta.provider).toBe("copilot")
    expect(meta.quotaState).toBe("ok")
    expect(meta.settings).toEqual({ baseUrl: "https://api.example.com" })
    expect(meta.authStatus).toBe("ready")
  })

  test("is idempotent (running twice produces same result)", () => {
    const v1 = makeV1Connection()
    const v2 = upgradeConnectionV1ToV2(v1)
    const v3 = upgradeConnectionV1ToV2(v2)

    expect(v3).toEqual(v2)
  })

  test("handles connection without metadata", () => {
    const conn: ProviderConnection = {
      id: "no-meta",
      name: "no-meta",
      protocol: "copilot-native",
      baseUrl: "",
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
      credentials: [
        {
          id: "no-meta",
          authMode: "bearer",
          value: "token",
          enabled: true,
          status: "ready",
          createdAt: Date.now(),
        },
      ],
    }
    const result = upgradeConnectionV1ToV2(conn)
    expect(result).toEqual(conn)
  })

  test("handles connection with empty metadata", () => {
    const conn: ProviderConnection = {
      id: "empty-meta",
      name: "empty-meta",
      protocol: "copilot-native",
      baseUrl: "",
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
      credentials: [
        {
          id: "empty-meta",
          authMode: "bearer",
          value: "token",
          enabled: true,
          status: "ready",
          createdAt: Date.now(),
        },
      ],
      metadata: {},
    }
    const result = upgradeConnectionV1ToV2(conn)
    expect(result.proxyUrl).toBeUndefined()
    expect(result.modelPrefix).toBeUndefined()
    expect(result.credentials[0].quota).toBeUndefined()
  })

  test("does not overwrite existing typed fields", () => {
    const conn: ProviderConnection = {
      id: "has-typed",
      name: "has-typed",
      protocol: "copilot-native",
      baseUrl: "",
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
      proxyUrl: "http://existing.proxy",
      modelPrefix: "existing-",
      credentials: [
        {
          id: "has-typed",
          authMode: "bearer",
          value: "token",
          enabled: true,
          status: "ready",
          createdAt: Date.now(),
          exhaustedAt: 9999,
        },
      ],
      metadata: {
        proxyUrl: "http://should-not-overwrite",
        modelPrefix: "should-not-",
        quotaExhaustedAt: 1111,
      },
    }
    const result = upgradeConnectionV1ToV2(conn)

    // Existing typed fields should not be overwritten
    expect(result.proxyUrl).toBe("http://existing.proxy")
    expect(result.modelPrefix).toBe("existing-")
    expect(result.credentials[0].exhaustedAt).toBe(9999)
  })
})
