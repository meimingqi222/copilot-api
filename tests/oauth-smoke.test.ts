import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { OAuthAccount } from "~/lib/accounts"

import { isOAuthAccount } from "~/lib/accounts"
import { PATHS } from "~/lib/paths"
import { buildRouteTargets, resolveModelRouting } from "~/lib/route-target"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { server } from "~/server"
import { resetOAuthFlowsForTest } from "~/services/oauth/flows"
import { initializeProviderRegistry } from "~/services/providers"

const originalAccounts = state.accounts
const originalFetch = globalThis.fetch
const originalAccountsPath = PATHS.ACCOUNTS_PATH
const originalOAuthFlowsPath = PATHS.PENDING_OAUTH_FLOWS_PATH
const testDir = path.join(process.cwd(), ".tmp-oauth-smoke")
const testAccountsPath = path.join(testDir, "accounts.json")
const testOAuthFlowsPath = path.join(testDir, "pending_oauth_flows.json")

async function adminJson(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return await server.fetch(
    new Request(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
    }),
  )
}

beforeEach(async () => {
  await fs.mkdir(testDir, { recursive: true })
  PATHS.ACCOUNTS_PATH = testAccountsPath
  PATHS.PENDING_OAUTH_FLOWS_PATH = testOAuthFlowsPath
  await fs.writeFile(testOAuthFlowsPath, "{}")
  initializeProviderRegistry()
  state.accounts = []
  state.legacyApiKey = undefined
  state.adminPassword = undefined
})

afterEach(async () => {
  resetOAuthFlowsForTest()
  state.accounts = originalAccounts
  globalThis.fetch = originalFetch
  PATHS.ACCOUNTS_PATH = originalAccountsPath
  PATHS.PENDING_OAUTH_FLOWS_PATH = originalOAuthFlowsPath
  resetAdaptiveRateLimiterForTest()
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => undefined)
})

describe("OAuth smoke — admin API", () => {
  test("GET /health responds OK", async () => {
    const response = await server.fetch(new Request("http://localhost/health"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("OK")
  })

  test("GET /admin/api/providers lists OAuth providers with proxy field", async () => {
    const response = await adminJson("http://localhost/admin/api/providers")
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      providers: Array<{
        id: string
        authMode: string
        accountFields: Array<{ key: string }>
      }>
    }

    for (const providerId of [
      "codex",
      "claude",
      "antigravity",
      "kimi",
      "xai",
    ]) {
      const provider = body.providers.find((item) => item.id === providerId)
      expect(provider?.authMode).toBe("oauth")
      expect(
        provider?.accountFields.some((field) => field.key === "proxyUrl"),
      ).toBe(true)
    }
  })

  test("POST /admin/api/oauth/kimi/start accepts proxyUrl and returns device flow", async () => {
    globalThis.fetch = ((url: string | URL | Request) => {
      const target = String(url)
      if (target.includes("device_authorization")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              device_code: "device-smoke-1",
              user_code: "SMOK-1234",
              verification_uri_complete:
                "https://auth.kimi.com/device?code=SMOK-1234",
              expires_in: 600,
              interval: 5,
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("{}", { status: 404 }))
    }) as unknown as typeof fetch

    const response = await adminJson(
      "http://localhost/admin/api/oauth/kimi/start",
      {
        method: "POST",
        body: JSON.stringify({
          label: "kimi-smoke",
          proxyUrl: "http://127.0.0.1:7890",
        }),
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      flowId: string
      status: string
      userCode: string
      verificationUri: string
    }
    expect(body.status).toBe("pending_auth")
    expect(body.userCode).toBe("SMOK-1234")
    expect(body.flowId.length).toBeGreaterThan(0)

    const poll = await adminJson(
      `http://localhost/admin/api/oauth/kimi/poll/${body.flowId}`,
    )
    expect(poll.status).toBe(200)
    const pollBody = (await poll.json()) as { status: string }
    expect(["pending", "error"]).toContain(pollBody.status)
  })

  test("POST /admin/api/oauth/:provider/start rejects concurrent same-provider flow", async () => {
    globalThis.fetch = ((url: string | URL | Request) => {
      const target = String(url)
      if (target.includes("device_authorization")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              device_code: "device-smoke-2",
              user_code: "SMOK-5678",
              verification_uri_complete: "https://auth.kimi.com/device",
              expires_in: 600,
              interval: 5,
            }),
            { status: 200 },
          ),
        )
      }
      if (target.includes("token")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: "authorization_pending" }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("{}", { status: 404 }))
    }) as unknown as typeof fetch

    const first = await adminJson(
      "http://localhost/admin/api/oauth/kimi/start",
      { method: "POST", body: JSON.stringify({ label: "kimi-a" }) },
    )
    expect(first.status).toBe(200)

    const second = await adminJson(
      "http://localhost/admin/api/oauth/kimi/start",
      { method: "POST", body: JSON.stringify({ label: "kimi-b" }) },
    )
    expect(second.status).toBe(409)
  })

  test("GET /admin/api/oauth/:provider/poll validates provider", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "device-smoke-3",
            user_code: "SMOK-9012",
            verification_uri_complete: "https://auth.kimi.com/device",
            expires_in: 600,
            interval: 5,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const start = await adminJson(
      "http://localhost/admin/api/oauth/kimi/start",
      { method: "POST", body: JSON.stringify({ label: "kimi-poll" }) },
    )
    const { flowId } = (await start.json()) as { flowId: string }

    const mismatch = await adminJson(
      `http://localhost/admin/api/oauth/claude/poll/${flowId}`,
    )
    expect(mismatch.status).toBe(404)
  })

  test("POST /admin/api/oauth/claude/start returns auth URL", async () => {
    const response = await adminJson(
      "http://localhost/admin/api/oauth/claude/start",
      {
        method: "POST",
        body: JSON.stringify({
          label: "claude-smoke",
          proxyUrl: "http://proxy.local:8080",
        }),
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      flowId: string
      authUrl: string
      status: string
    }
    expect(body.status).toBe("pending_auth")
    expect(body.authUrl).toContain("claude.ai")
    expect(body.authUrl).toContain("code_challenge")
  })

  test("POST /admin/api/accounts/import-cpa imports OAuth account", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch

    const response = await adminJson(
      "http://localhost/admin/api/accounts/import-cpa",
      {
        method: "POST",
        body: JSON.stringify({
          records: [
            {
              type: "claude",
              access_token: "cpa-access",
              refresh_token: "cpa-refresh",
              email: "smoke@example.com",
              proxy_url: "http://127.0.0.1:7890",
            },
          ],
        }),
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      imported: number
      details: { imported: string[] }
    }
    expect(body.imported).toBe(1)
    expect(state.accounts).toHaveLength(1)

    const account = state.accounts[0]
    expect(account?.provider).toBe("claude")
    expect(isOAuthAccount(account!) && account.settings?.proxyUrl).toBe(
      "http://127.0.0.1:7890",
    )
    expect(
      (account as { cpaMetadata?: Record<string, unknown> }).cpaMetadata,
    ).not.toHaveProperty("access_token")
  })

  test("PUT /admin/api/accounts/:id updates OAuth proxyUrl", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch

    await adminJson("http://localhost/admin/api/accounts/import-cpa", {
      method: "POST",
      body: JSON.stringify({
        records: [{ type: "xai", access_token: "xai-token" }],
      }),
    })

    const accountId = state.accounts[0]?.id
    expect(accountId).toBeDefined()

    const response = await adminJson(
      `http://localhost/admin/api/accounts/${accountId}`,
      {
        method: "PUT",
        body: JSON.stringify({
          settings: { proxyUrl: "http://127.0.0.1:8888" },
        }),
      },
    )

    expect(response.status).toBe(200)
    const updated = state.accounts[0]
    expect(isOAuthAccount(updated!) && updated.settings?.proxyUrl).toBe(
      "http://127.0.0.1:8888",
    )
  })
})

describe("OAuth smoke — routing", () => {
  test("resolves prefixed OAuth model to correct provider account", () => {
    const claudeAccount: OAuthAccount = {
      id: "claude-smoke",
      label: "claude",
      provider: "claude",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: { accessToken: "token" },
      settings: { modelPrefix: "work" },
      runtimeState: { authStatus: "ready" },
      availableModels: [
        {
          id: "claude-sonnet-4-6",
          name: "claude-sonnet-4-6",
          vendor: "Anthropic",
          pickerEnabled: true,
          supportedEndpoints: ["/v1/messages"],
          provider: "claude",
        },
      ],
    }
    state.accounts = [claudeAccount]

    const routing = resolveModelRouting("work/claude-sonnet-4-6")
    expect(routing.accountPrefix).toBe("work")
    expect(routing.modelId).toBe("claude-sonnet-4-6")

    const targets = buildRouteTargets({
      legacyProvider: "claude",
      publicModelId: "work/claude-sonnet-4-6",
      endpoint: "messages",
    })
    expect(targets).toHaveLength(1)
    expect(targets[0]?.account?.id).toBe("claude-smoke")
  })
})