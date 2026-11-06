import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { TestAccount as OAuthAccount } from "./helpers/set-accounts"

import { listTestAccounts as listAccounts } from "./helpers/set-accounts"
import { claudeAllowance } from "~/lib/quota/fetchers/claude"
import { kimiAllowance } from "~/lib/quota/fetchers/kimi"
import {
  parseClaudeUsagePayload,
  parseKimiUsagePayload,
  summarizeClaudeQuota,
  summarizeKimiQuota,
} from "~/lib/quota/parsers"
import {
  getConnectionAuthStatus,
  getMutableProviderConnection,
  managedConnectionFromInput,
} from "~/lib/provider-connections"
import {
  buildClaudeAuthUrl,
  exchangeClaudeCodeForTokens,
  refreshClaudeTokens,
} from "~/services/oauth/claude"
import {
  pollKimiDeviceAuthorization,
  refreshKimiTokens,
  startKimiDeviceFlow,
  stripKimiModelPrefix,
} from "~/services/oauth/kimi"
import { generatePkceCodes } from "~/services/oauth/pkce"
import { refreshOAuthConnectionToken } from "~/services/oauth/refresh-scheduler"

import { setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = listAccounts()
const originalFetch = globalThis.fetch

beforeEach(() => {
  setTestAccounts([])
})

afterEach(() => {
  setTestAccounts(originalAccounts)
  globalThis.fetch = originalFetch
})

describe("Claude OAuth", () => {
  test("buildClaudeAuthUrl includes PKCE and state", () => {
    const pkce = generatePkceCodes()
    const url = new URL(buildClaudeAuthUrl("state-123", pkce))
    expect(url.searchParams.get("state")).toBe("state-123")
    expect(url.searchParams.get("code_challenge")).toBe(pkce.codeChallenge)
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:54545/callback",
    )
  })

  test("exchangeClaudeCodeForTokens parses token response", async () => {
    const pkce = generatePkceCodes()
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
            account: { email_address: "user@example.com" },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const bundle = await exchangeClaudeCodeForTokens("code-1", "state-1", pkce)
    expect(bundle.accessToken).toBe("access-1")
    expect(bundle.refreshToken).toBe("refresh-1")
    expect(bundle.email).toBe("user@example.com")
    expect(bundle.expiresAt).toBeGreaterThan(Date.now())
  })

  test("refreshClaudeTokens updates access token", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 1800,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const bundle = await refreshClaudeTokens("refresh-1")
    expect(bundle.accessToken).toBe("access-2")
    expect(bundle.refreshToken).toBe("refresh-2")
  })
})

describe("Kimi OAuth", () => {
  test("startKimiDeviceFlow returns device code payload", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "device-1",
            user_code: "ABCD-1234",
            verification_uri_complete:
              "https://auth.kimi.com/device?code=ABCD-1234",
            expires_in: 600,
            interval: 5,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const deviceCode = await startKimiDeviceFlow("device-id-1")
    expect(deviceCode.device_code).toBe("device-1")
    expect(deviceCode.user_code).toBe("ABCD-1234")
  })

  test("pollKimiDeviceAuthorization resolves on access token", async () => {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      if (calls === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "authorization_pending" }), {
            status: 200,
          }),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "kimi-access",
            refresh_token: "kimi-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const bundle = await pollKimiDeviceAuthorization(
      {
        device_code: "device-1",
        interval: 0,
        expires_in: 30,
      },
      "device-id-1",
    )

    expect(bundle.accessToken).toBe("kimi-access")
    expect(bundle.refreshToken).toBe("kimi-refresh")
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  test("refreshKimiTokens exchanges refresh token", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "kimi-access-2",
            refresh_token: "kimi-refresh-2",
            expires_in: 1800,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const bundle = await refreshKimiTokens("kimi-refresh", "device-id-1")
    expect(bundle.accessToken).toBe("kimi-access-2")
  })

  test("stripKimiModelPrefix removes legacy kimi- prefixes but keeps Kimi Code ids", () => {
    expect(stripKimiModelPrefix("kimi-k2")).toBe("k2")
    expect(stripKimiModelPrefix("KIMI-k2-thinking")).toBe("k2-thinking")
    expect(stripKimiModelPrefix("kimi-for-coding")).toBe("kimi-for-coding")
    expect(stripKimiModelPrefix("kimi-for-coding-highspeed")).toBe(
      "kimi-for-coding-highspeed",
    )
    expect(stripKimiModelPrefix("k3.1-pro")).toBe("k3.1-pro")
  })
})

describe("OAuth quota parsers", () => {
  test("canonical Claude windows preserve unknown resets and exact native family scope", () => {
    const connection = managedConnectionFromInput({
      provider: "claude",
      id: "claude-quota",
      name: "quota",
      credentials: { accessToken: "test" },
    })
    connection.models = ["claude-opus-4-6", "claude-sonnet-4-6"].map((id) => ({
      publicId: `alias-${id}`,
      upstreamId: id,
      endpoints: ["messages"],
      enabled: true,
    }))
    const allowance = claudeAllowance(
      {
        five_hour: { resets_at: "2026-11-07T00:00:00Z" },
        seven_day_opus: { utilization: 1 },
        seven_day_sonnet: { utilization: 0.2 },
      },
      connection,
    )
    expect(allowance.state).toBe("known")
    expect(allowance.windows[0]?.used).toBeUndefined()
    expect(allowance.windows[0]?.resetsAtMs).toBe(
      Date.parse("2026-11-07T00:00:00Z"),
    )
    expect(allowance.windows[1]).toMatchObject({
      used: 1,
      scope: { models: ["claude-opus-4-6"] },
    })
    expect(allowance.windows[1]?.resetsAtMs).toBeUndefined()
    expect(allowance.windows[2]).toMatchObject({
      used: 0.2,
      scope: { models: ["claude-sonnet-4-6"] },
    })
    expect(claudeAllowance({}, connection)).toEqual({
      state: "unknown",
      windows: [],
    })
    connection.models = []
    expect(
      claudeAllowance({ seven_day_opus: { utilization: 1 } }, connection)
        .windows[0]?.scope,
    ).toEqual({ models: [] })
  })

  test("canonical Kimi keeps independent ratios even when absolute remaining orders differently", () => {
    const allowance = kimiAllowance(
      {
        limits: [
          { name: "small", remaining: 2, limit: 10 },
          { name: "large", remaining: 10, limit: 1000 },
          { name: "unknown", window: { reset_in: 60 } },
        ],
      },
      1000,
    )
    expect(allowance.windows[0]?.used).toBeCloseTo(0.8)
    expect(allowance.windows.every((window) => window.unit === "units")).toBe(
      true,
    )
    expect(allowance.windows[1]?.used).toBeCloseTo(0.99)
    expect(allowance.windows[0]?.resetsAtMs).toBeUndefined()
    expect(allowance.windows[2]).toMatchObject({
      id: "limit-unknown",
      resetsAtMs: 61_000,
    })
    expect(allowance.windows[2]?.used).toBeUndefined()
    expect(kimiAllowance({}).state).toBe("unknown")
  })

  test("summarizeClaudeQuota picks lowest remaining window", () => {
    // /api/oauth/usage reports percent; the parser converts it to a 0..1 share.
    const payload = parseClaudeUsagePayload({
      five_hour: { utilization: 20, resets_at: "2026-01-01T00:00:00Z" },
      seven_day: { utilization: 80, resets_at: "2026-01-07T00:00:00Z" },
    })
    if (!payload) {
      throw new Error("expected Claude usage payload")
    }
    const summary = summarizeClaudeQuota(payload)
    expect(summary.remainingFraction).toBeCloseTo(0.2)
    expect(summary.unlimited).toBe(false)
    expect(payload.five_hour?.utilization).toBeCloseTo(0.2)
  })

  test("summarizeKimiQuota uses remaining counts", () => {
    const payload = parseKimiUsagePayload({
      limits: [
        { name: "daily", remaining: 12, limit: 100 },
        { name: "weekly", remaining: 3, limit: 50 },
      ],
    })
    if (!payload) {
      throw new Error("expected Kimi usage payload")
    }
    const summary = summarizeKimiQuota(payload)
    expect(summary.remaining).toBe(3)
    expect(summary.total).toBe(50)
  })
})

describe("OAuth refresh scheduler", () => {
  test("refreshOAuthConnectionToken refreshes Claude account tokens", async () => {
    const account: OAuthAccount = {
      id: "acct-claude",
      label: "Claude Test",
      provider: "claude",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "old-access",
        refreshToken: "refresh-token",
      },
    }
    setTestAccounts([account])

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const connection = getMutableProviderConnection("acct-claude")
    if (!connection) throw new Error("connection not found")
    await refreshOAuthConnectionToken(connection, "test")
    expect(connection.credentials[0]?.value).toBe("new-access")
    expect(connection.credentials[0]?.context?.refreshToken).toBe("new-refresh")
    expect(getConnectionAuthStatus(connection)).toBe("ready")
  })
})
