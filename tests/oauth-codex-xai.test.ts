import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { OAuthAccount } from "~/lib/accounts"

import { listAccounts } from "~/lib/accounts"
import { applyOAuthQuotaSnapshot } from "~/lib/quota"
import { buildCodexQuotaMeta, buildCodexQuotaWindows } from "~/lib/quota/codex"
import {
  parseCodexUsagePayload,
  parseXaiBillingPayload,
  summarizeCodexQuota,
  summarizeXaiQuota,
} from "~/lib/quota/parsers"
import { supportsResponsesApi } from "~/services/copilot/responses-api-types"
import {
  buildCodexAuthUrl,
  exchangeCodexCodeForTokens,
  refreshCodexTokens,
} from "~/services/oauth/codex"
import {
  extractCodexPlanTypeFromIdToken,
  extractCodexSubscriptionActiveUntilFromIdToken,
} from "~/services/oauth/jwt"
import { generatePkceCodes } from "~/services/oauth/pkce"
import {
  refreshOAuthAccountToken,
  clearOAuthAuthError,
} from "~/services/oauth/refresh-scheduler"
import {
  buildXaiAuthUrl,
  discoverXaiOAuthEndpoints,
  exchangeXaiCodeForTokens,
  refreshXaiTokens,
} from "~/services/oauth/xai"
import { collectResponsesFromSseText } from "~/services/responses/sse-collector"

import { setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = listAccounts()
const originalFetch = globalThis.fetch

function toBase64UrlForTest(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll(/=+$/g, "")
}

/** Synthetic JWT for unit tests only — not a real credential. */
function buildFakeJwtForTest(payload: Record<string, unknown>): string {
  const header = toBase64UrlForTest(
    JSON.stringify({ alg: "TEST", typ: "JWT", purpose: "unit-test-only" }),
  )
  const body = toBase64UrlForTest(JSON.stringify(payload))
  return `${header}.${body}.test-signature-not-valid`
}

const CODEX_ID_TOKEN = buildFakeJwtForTest({
  "https://api.openai.com/auth": {
    chatgpt_account_id: "acct-test-123",
  },
  email: "test-user@example.invalid",
})

beforeEach(() => {
  setTestAccounts([])
})

afterEach(() => {
  setTestAccounts(originalAccounts)
  globalThis.fetch = originalFetch
})

describe("Codex OAuth", () => {
  test("buildCodexAuthUrl includes PKCE and callback", () => {
    const pkce = generatePkceCodes()
    const url = new URL(buildCodexAuthUrl("state-123", pkce))
    expect(url.searchParams.get("state")).toBe("state-123")
    expect(url.searchParams.get("code_challenge")).toBe(pkce.codeChallenge)
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    )
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true")
  })

  test("exchangeCodexCodeForTokens parses token response", async () => {
    const pkce = generatePkceCodes()
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "codex-access",
            refresh_token: "codex-refresh",
            id_token: CODEX_ID_TOKEN,
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const bundle = await exchangeCodexCodeForTokens("code-1", pkce)
    expect(bundle.accessToken).toBe("codex-access")
    expect(bundle.refreshToken).toBe("codex-refresh")
    expect(bundle.accountId).toBe("acct-test-123")
    expect(bundle.email).toBe("test-user@example.invalid")
    expect(bundle.expiresAt).toBeGreaterThan(Date.now())
  })

  test("refreshCodexTokens preserves refresh token fallback", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "codex-access-2",
            expires_in: 1800,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const bundle = await refreshCodexTokens("codex-refresh")
    expect(bundle.accessToken).toBe("codex-access-2")
    expect(bundle.refreshToken).toBe("codex-refresh")
  })
})

describe("xAI OAuth", () => {
  test("discoverXaiOAuthEndpoints returns endpoints", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            authorization_endpoint: "https://auth.x.ai/oauth/authorize",
            token_endpoint: "https://auth.x.ai/oauth/token",
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const discovery = await discoverXaiOAuthEndpoints()
    expect(discovery.authorization_endpoint).toContain("authorize")
    expect(discovery.token_endpoint).toContain("token")
  })

  test("buildXaiAuthUrl includes nonce and PKCE", () => {
    const pkce = generatePkceCodes()
    const url = new URL(
      buildXaiAuthUrl({
        authorizationEndpoint: "https://auth.x.ai/oauth/authorize",
        state: "state-1",
        nonce: "nonce-1",
        pkce,
      }),
    )
    expect(url.searchParams.get("nonce")).toBe("nonce-1")
    expect(url.searchParams.get("code_challenge")).toBe(pkce.codeChallenge)
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:56121/callback",
    )
  })

  test("exchangeXaiCodeForTokens parses token response", async () => {
    const pkce = generatePkceCodes()
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "xai-access",
            refresh_token: "xai-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const bundle = await exchangeXaiCodeForTokens(
      "code-1",
      pkce,
      "https://auth.x.ai/oauth/token",
    )
    expect(bundle.accessToken).toBe("xai-access")
    expect(bundle.refreshToken).toBe("xai-refresh")
    expect(bundle.tokenEndpoint).toBe("https://auth.x.ai/oauth/token")
  })

  test("refreshXaiTokens updates access token", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "xai-access-2",
            refresh_token: "xai-refresh-2",
            expires_in: 1800,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const bundle = await refreshXaiTokens(
      "xai-refresh",
      "https://auth.x.ai/oauth/token",
    )
    expect(bundle.accessToken).toBe("xai-access-2")
    expect(bundle.refreshToken).toBe("xai-refresh-2")
  })
})

describe("Responses SSE collector", () => {
  test("collectResponsesFromSseText assembles response.completed output", () => {
    const sse = [
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","content":[{"type":"output_text","text":"hello"}]}}',
      'data: {"type":"response.completed","response":{"id":"resp-1","status":"completed","output":[]}}',
    ].join("\n")

    const response = collectResponsesFromSseText(sse, "gpt-5")
    expect(response.id).toBe("resp-1")
    expect(response.model).toBe("gpt-5")
    expect(response.output?.[0]?.type).toBe("message")
  })

  test("collectResponsesFromSseText throws on terminal error event", () => {
    const sse =
      'data: {"type":"response.failed","error":{"message":"quota exceeded"}}'
    expect(() => collectResponsesFromSseText(sse, "gpt-5")).toThrow(
      "quota exceeded",
    )
  })
})

describe("Codex and xAI quota parsers", () => {
  test("summarizeCodexQuota picks lowest remaining window", () => {
    const payload = parseCodexUsagePayload({
      rate_limit: {
        primary_window: { used_percent: 20 },
        secondary_window: { used_percent: 85 },
      },
    })
    if (!payload) {
      throw new Error("expected Codex usage payload")
    }
    const summary = summarizeCodexQuota(payload)
    expect(summary.remainingPercent).toBe(15)
    expect(summary.unlimited).toBe(false)
  })

  test("buildCodexQuotaWindows classifies 5-hour and weekly windows", () => {
    const payload = parseCodexUsagePayload({
      plan_type: "team",
      rate_limit: {
        primary_window: {
          used_percent: 93,
          limit_window_seconds: 18000,
          reset_at: 1_751_300_000,
        },
        secondary_window: {
          used_percent: 69,
          limit_window_seconds: 604800,
          reset_after_seconds: 3600,
        },
      },
      rate_limit_reset_credits: {
        available_count: 1,
      },
    })
    if (!payload) {
      throw new Error("expected Codex usage payload")
    }

    const windows = buildCodexQuotaWindows(payload)
    expect(windows).toHaveLength(2)
    expect(windows[0]?.labelKey).toBe("quota.oauth.codex.fiveHour")
    expect(windows[0]?.usedPercent).toBe(93)
    expect(windows[0]?.resetAtSeconds).toBe(1_751_300_000)
    expect(windows[1]?.labelKey).toBe("quota.oauth.codex.weekly")
    expect(windows[1]?.usedPercent).toBe(69)
    expect(windows[1]?.resetAtSeconds).toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    )
  })

  test("buildCodexQuotaMeta includes reset credits and plan type", () => {
    const account: OAuthAccount = {
      id: "acct-codex-meta",
      label: "Codex Meta",
      provider: "codex",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "token",
        idToken: CODEX_ID_TOKEN,
      },
    }
    const payload = parseCodexUsagePayload({
      plan_type: "team",
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
      },
      rate_limit_reset_credits: { available_count: 2 },
    })
    if (!payload) {
      throw new Error("expected Codex usage payload")
    }

    const meta = buildCodexQuotaMeta(account, payload)
    expect(meta.planType).toBe("team")
    expect(meta.rateLimitResetCreditsAvailableCount).toBe(2)
    expect(meta.windows).toHaveLength(2)
  })

  test("extractCodexPlanTypeFromIdToken reads chatgpt plan type", () => {
    const token = buildFakeJwtForTest({
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "team",
        chatgpt_subscription_active_until: 1_751_300_000,
      },
      email: "test-user@example.invalid",
    })
    expect(extractCodexPlanTypeFromIdToken(token)).toBe("team")
    expect(extractCodexSubscriptionActiveUntilFromIdToken(token)).toBe(
      1_751_300_000,
    )
  })

  test("summarizeXaiQuota computes remaining credits", () => {
    const payload = parseXaiBillingPayload({
      config: {
        monthly_limit: { val: 1000 },
        used: { val: 250 },
      },
    })
    if (!payload) {
      throw new Error("expected xAI billing payload")
    }
    const summary = summarizeXaiQuota(payload)
    expect(summary.remainingCents).toBe(750)
    expect(summary.remainingPercent).toBe(75)
    expect(summary.unlimited).toBe(false)
  })

  test("summarizeXaiQuota computes remaining from weekly creditUsagePercent", () => {
    const payload = parseXaiBillingPayload({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-04T21:56:51.039287+00:00",
          end: "2026-07-11T21:56:51.039287+00:00",
        },
        creditUsagePercent: 100,
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        billingPeriodEnd: "2026-07-11T21:56:51.039287+00:00",
      },
    })
    if (!payload) {
      throw new Error("expected xAI billing payload")
    }
    const summary = summarizeXaiQuota(payload)
    expect(summary.remainingCents).toBeUndefined()
    expect(summary.totalCents).toBeUndefined()
    expect(summary.remainingPercent).toBe(0)
    expect(summary.unlimited).toBe(false)
  })

  test("summarizeXaiQuota uses stricter remaining between monthly and weekly", () => {
    const payload = parseXaiBillingPayload({
      config: {
        monthly_limit: { val: 1000 },
        used: { val: 100 },
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "2026-07-11T21:56:51.039287+00:00",
        },
        creditUsagePercent: 100,
      },
    })
    if (!payload) {
      throw new Error("expected xAI billing payload")
    }
    const summary = summarizeXaiQuota(payload)
    expect(summary.remainingCents).toBe(900)
    expect(summary.remainingPercent).toBe(0)
    expect(summary.unlimited).toBe(false)
  })

  test("applyOAuthQuotaSnapshot does not exhaust xAI accounts with no monthly limit", () => {
    // Regression: Grok CLI style accounts have monthly_limit = 0 and a weekly
    // creditUsagePercent. The count threshold must not treat the $0 monthly
    // balance as exhausted.
    const account: OAuthAccount = {
      id: "acct-xai-no-monthly",
      label: "xAI (Grok CLI)",
      provider: "xai",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: { accessToken: "token" },
    }

    applyOAuthQuotaSnapshot(account, {
      fetchedAt: Date.now(),
      provider: "xai",
      unlimited: false,
      premiumInteractionsRemaining: 94,
      chatRemaining: 0,
      chatTotal: 0,
      details: {},
    })

    expect(account.quotaState).toBe("available")

    applyOAuthQuotaSnapshot(account, {
      fetchedAt: Date.now(),
      provider: "xai",
      unlimited: false,
      premiumInteractionsRemaining: 0,
      chatRemaining: 0,
      chatTotal: 0,
      details: {},
    })

    expect(account.quotaState).toBe("exhausted")
  })
})

describe("supportsResponsesApi", () => {
  test("returns true for Codex and xAI OAuth accounts", () => {
    const codexAccount: OAuthAccount = {
      id: "acct-codex",
      label: "Codex",
      provider: "codex",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: { accessToken: "token" },
    }
    const xaiAccount: OAuthAccount = {
      id: "acct-xai",
      label: "xAI",
      provider: "xai",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: { accessToken: "token" },
    }

    expect(supportsResponsesApi("gpt-5", codexAccount)).toBe(true)
    expect(supportsResponsesApi("grok-3", xaiAccount)).toBe(true)
  })
})

describe("OAuth refresh scheduler", () => {
  test("refreshOAuthAccountToken refreshes Codex account tokens", async () => {
    const account: OAuthAccount = {
      id: "acct-codex",
      label: "Codex Test",
      provider: "codex",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "old-access",
        refreshToken: "codex-refresh",
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

    await refreshOAuthAccountToken(account, "test")
    expect(account.credentials?.accessToken).toBe("new-access")
    expect(account.credentials?.refreshToken).toBe("new-refresh")
    expect(account.runtimeState?.authStatus).toBe("ready")
  })

  test("refreshOAuthAccountToken refreshes xAI account tokens", async () => {
    const account: OAuthAccount = {
      id: "acct-xai",
      label: "xAI Test",
      provider: "xai",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "old-access",
        refreshToken: "xai-refresh",
      },
      settings: {
        tokenEndpoint: "https://auth.x.ai/oauth/token",
      },
    }
    setTestAccounts([account])

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "xai-new-access",
            refresh_token: "xai-new-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    await refreshOAuthAccountToken(account, "test")
    expect(account.credentials?.accessToken).toBe("xai-new-access")
    expect(account.credentials?.refreshToken).toBe("xai-new-refresh")
    expect(account.runtimeState?.authStatus).toBe("ready")
  })

  test("refreshOAuthAccountToken resets authStatus to ready on success after prior error", async () => {
    const account: OAuthAccount = {
      id: "acct-codex-recover",
      label: "Codex Recover",
      provider: "codex",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "old-access",
        refreshToken: "codex-refresh",
      },
      runtimeState: { authStatus: "error", lastError: "previous failure" },
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

    await refreshOAuthAccountToken(account, "test")
    expect(account.credentials?.accessToken).toBe("new-access")
    expect(account.runtimeState?.authStatus).toBe("ready")
    expect(account.runtimeState?.lastError).toBeUndefined()
    expect(account.runtimeState?.lastRefreshAt).toBeDefined()
  })

  test("refreshOAuthAccountToken sets authStatus to error on failure", async () => {
    const account: OAuthAccount = {
      id: "acct-codex-fail",
      label: "Codex Fail",
      provider: "codex",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "old-access",
        refreshToken: "codex-refresh",
      },
      runtimeState: { authStatus: "ready" },
    }
    setTestAccounts([account])

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 500,
        }),
      )) as unknown as typeof fetch

    let threw = false
    try {
      await refreshOAuthAccountToken(account, "test")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(account.runtimeState?.authStatus).toBe("error")
    expect(account.runtimeState?.lastError).toContain("Codex token refresh")
  })

  test("clearOAuthAuthError resets authStatus and reschedules", () => {
    const account: OAuthAccount = {
      id: "acct-codex-clear",
      label: "Codex Clear",
      provider: "codex",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: Date.now() + 3600_000,
      },
      runtimeState: { authStatus: "error", lastError: "broken" },
    }
    setTestAccounts([account])

    clearOAuthAuthError(account.id)

    // After clearing, the account should no longer have authStatus === "error".
    // buildRuntimeState only sets authStatus when it's NOT "ready", so
    // authStatus being undefined means the account is in the default ready state.
    const updated = listAccounts().find((a) => a.id === account.id)
    expect(updated?.runtimeState?.authStatus).not.toBe("error")
    expect(updated?.runtimeState?.lastError).toBeUndefined()
  })
})
