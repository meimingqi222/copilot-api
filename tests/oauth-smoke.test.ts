import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { OAuthAccount } from "~/lib/legacy-accounts"

import { isOAuthAccount, listAccounts } from "~/lib/legacy-accounts"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { buildRouteTargets, resolveModelRouting } from "~/lib/route-target"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import { resetOAuthFlowsForTest } from "~/services/oauth/flows"
import { initializeProviderRegistry } from "~/services/providers"

import {
  adminHeaders,
  clearAdminAuth,
  clearAdminPasswordConfig,
  setupAdminAuth,
} from "./admin-test-utils"
import { setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = listAccounts()
const originalFetch = globalThis.fetch
const isolationRoot = PATHS.APP_DIR
const testDir = path.join(process.cwd(), ".tmp-oauth-smoke")

function fetchTarget(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url
  }
  if (url instanceof URL) {
    return url.toString()
  }
  return url.url
}

async function adminJson(url: string, init?: RequestInit): Promise<Response> {
  const headers = adminHeaders(init?.headers)
  headers.set("content-type", "application/json")
  return await server.fetch(
    new Request(url, {
      ...init,
      headers,
    }),
  )
}

beforeEach(async () => {
  await fs.mkdir(testDir, { recursive: true })
  redirectPathsToDir(testDir)
  await fs.writeFile(PATHS.PENDING_OAUTH_FLOWS_PATH, "{}")
  initializeProviderRegistry()
  statsStore.clearUsageStatsForTest()
  setTestAccounts([])
  state.users = []
  state.legacyApiKey = undefined
  state.adminPassword = undefined
  clearAdminPasswordConfig()
  setupAdminAuth()
})

afterEach(async () => {
  resetOAuthFlowsForTest()
  setTestAccounts(originalAccounts)
  globalThis.fetch = originalFetch
  redirectPathsToDir(isolationRoot)
  resetAdaptiveRateLimiterForTest()
  clearAdminAuth()
  clearAdminPasswordConfig()
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
      const target = fetchTarget(url)
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
      const target = fetchTarget(url)
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
          new Response(JSON.stringify({ error: "authorization_pending" }), {
            status: 200,
          }),
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

  test("POST /admin/api/oauth/xai/start with manual=true skips duplicate flow lock after cancel", async () => {
    globalThis.fetch = ((url: string | URL | Request) => {
      const target = fetchTarget(url)
      if (target.includes(".well-known/openid-configuration")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              authorization_endpoint: "https://auth.x.ai/oauth/authorize",
              token_endpoint: "https://auth.x.ai/oauth/token",
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("{}", { status: 404 }))
    }) as unknown as typeof fetch

    const start = await adminJson(
      "http://localhost/admin/api/oauth/xai/start",
      {
        method: "POST",
        body: JSON.stringify({
          label: "xai-smoke",
          manual: true,
        }),
      },
    )
    expect(start.status).toBe(200)
    const body = (await start.json()) as {
      flowId: string
      manualCompletion: boolean
      authUrl: string
    }
    expect(body.manualCompletion).toBe(true)
    expect(body.authUrl).toContain("auth.x.ai")

    const duplicate = await adminJson(
      "http://localhost/admin/api/oauth/xai/start",
      {
        method: "POST",
        body: JSON.stringify({ label: "xai-smoke-2", manual: true }),
      },
    )
    expect(duplicate.status).toBe(409)

    const cancel = await adminJson(
      "http://localhost/admin/api/oauth/xai/cancel",
      {
        method: "POST",
        body: JSON.stringify({ flowId: body.flowId }),
      },
    )
    expect(cancel.status).toBe(200)

    const restart = await adminJson(
      "http://localhost/admin/api/oauth/xai/start",
      {
        method: "POST",
        body: JSON.stringify({ label: "xai-smoke-3", manual: true }),
      },
    )
    expect(restart.status).toBe(200)
  })

  test("POST /admin/api/oauth/claude/complete exchanges manual callback", async () => {
    globalThis.fetch = ((url: string | URL | Request) => {
      const target = fetchTarget(url)
      if (target.includes("anthropic.com/v1/oauth/token")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "claude-access",
              refresh_token: "claude-refresh",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("{}", { status: 404 }))
    }) as unknown as typeof fetch

    const start = await adminJson(
      "http://localhost/admin/api/oauth/claude/start",
      {
        method: "POST",
        body: JSON.stringify({ label: "claude-complete", manual: true }),
      },
    )
    const { flowId } = (await start.json()) as { flowId: string }

    const complete = await adminJson(
      "http://localhost/admin/api/oauth/claude/complete",
      {
        method: "POST",
        body: JSON.stringify({
          flowId,
          callback:
            "http://localhost:54545/callback?code=claude-code-1&state=state-1",
        }),
      },
    )
    expect(complete.status).toBe(200)
    const body = (await complete.json()) as { status: string }
    expect(body.status).toBe("complete")
    expect(listAccounts()).toHaveLength(1)
    expect(listAccounts()[0]?.provider).toBe("claude")
  })

  test("POST /admin/api/oauth/codex/complete exchanges manual callback", async () => {
    globalThis.fetch = ((url: string | URL | Request) => {
      const target = fetchTarget(url)
      if (target.includes("auth.openai.com/oauth/token")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "codex-access",
              refresh_token: "codex-refresh",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("{}", { status: 404 }))
    }) as unknown as typeof fetch

    const start = await adminJson(
      "http://localhost/admin/api/oauth/codex/start",
      {
        method: "POST",
        body: JSON.stringify({ label: "codex-complete", manual: true }),
      },
    )
    const { flowId } = (await start.json()) as { flowId: string }

    const complete = await adminJson(
      "http://localhost/admin/api/oauth/codex/complete",
      {
        method: "POST",
        body: JSON.stringify({
          flowId,
          callback:
            "http://localhost:1455/auth/callback?code=codex-code-1&state=state-1",
        }),
      },
    )
    expect(complete.status).toBe(200)
    expect(listAccounts()[0]?.provider).toBe("codex")
  })

  test("POST /admin/api/oauth/kimi/cancel allows restarting device flow", async () => {
    globalThis.fetch = ((url: string | URL | Request) => {
      const target = fetchTarget(url)
      if (target.includes("device_authorization")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              device_code: "device-cancel-1",
              user_code: "KIMI-1234",
              verification_uri_complete: "https://auth.kimi.com/device",
              expires_in: 600,
              interval: 5,
            }),
            { status: 200 },
          ),
        )
      }
      if (target.includes("auth.kimi.com/api/oauth/token")) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "authorization_pending" }), {
            status: 200,
          }),
        )
      }
      return Promise.resolve(new Response("{}", { status: 404 }))
    }) as unknown as typeof fetch

    const start = await adminJson(
      "http://localhost/admin/api/oauth/kimi/start",
      {
        method: "POST",
        body: JSON.stringify({ label: "kimi-cancel" }),
      },
    )
    const { flowId } = (await start.json()) as { flowId: string }

    const cancel = await adminJson(
      "http://localhost/admin/api/oauth/kimi/cancel",
      {
        method: "POST",
        body: JSON.stringify({ flowId }),
      },
    )
    expect(cancel.status).toBe(200)

    const restart = await adminJson(
      "http://localhost/admin/api/oauth/kimi/start",
      {
        method: "POST",
        body: JSON.stringify({ label: "kimi-cancel-2" }),
      },
    )
    expect(restart.status).toBe(200)
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
      Promise.resolve(
        new Response("{}", { status: 404 }),
      )) as unknown as typeof fetch

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
      details: { imported: Array<string> }
    }
    expect(body.imported).toBe(1)
    expect(listAccounts()).toHaveLength(1)

    const [account] = listAccounts()
    expect(account.provider).toBe("claude")
    expect(isOAuthAccount(account) && account.settings?.proxyUrl).toBe(
      "http://127.0.0.1:7890",
    )
    expect(
      (account as { cpaMetadata?: Record<string, unknown> }).cpaMetadata,
    ).not.toHaveProperty("access_token")
  })

  test("PUT /admin/api/accounts/:id updates OAuth proxyUrl", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("{}", { status: 404 }),
      )) as unknown as typeof fetch

    await adminJson("http://localhost/admin/api/accounts/import-cpa", {
      method: "POST",
      body: JSON.stringify({
        records: [{ type: "xai", access_token: "xai-token" }],
      }),
    })

    const accountId = listAccounts()[0]?.id
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
    const updated = listAccounts()[0]
    expect(isOAuthAccount(updated) && updated.settings?.proxyUrl).toBe(
      "http://127.0.0.1:8888",
    )
  })

  test("POST /admin/api/accounts/import imports OAuth accounts from standard export format", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("{}", { status: 404 }),
      )) as unknown as typeof fetch

    const response = await adminJson(
      "http://localhost/admin/api/accounts/import",
      {
        method: "POST",
        body: JSON.stringify({
          accounts: [
            {
              label: "codex-export",
              provider: "codex",
              credentials: {
                accessToken: "codex-access",
                refreshToken: "codex-refresh",
                idToken: "codex-id",
                accountId: "codex-account",
              },
              settings: { proxyUrl: "http://127.0.0.1:7890" },
            },
            {
              label: "xai-export",
              provider: "xai",
              credentials: {
                accessToken: "xai-access",
                refreshToken: "xai-refresh",
              },
              settings: { proxyUrl: "http://127.0.0.1:7891" },
            },
            {
              label: "antigravity-export",
              provider: "antigravity",
              credentials: { apiKey: "antigravity-key" },
              settings: { proxyUrl: "http://127.0.0.1:7892" },
            },
          ],
        }),
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      imported: number
      skipped: number
      failed: number
      details: { imported: Array<string>; failed: Array<{ label: string }> }
    }
    expect(body.imported).toBe(3)
    expect(body.skipped).toBe(0)
    expect(body.failed).toBe(0)
    expect(listAccounts()).toHaveLength(3)

    const codex = listAccounts().find((a) => a.label === "codex-export")
    expect(codex?.provider).toBe("codex")
    if (!codex) throw new Error("codex account missing")
    expect(isOAuthAccount(codex) && codex.credentials?.accessToken).toBe(
      "codex-access",
    )
    expect(isOAuthAccount(codex) && codex.credentials?.accountId).toBe(
      "codex-account",
    )
    expect(isOAuthAccount(codex) && codex.settings?.proxyUrl).toBe(
      "http://127.0.0.1:7890",
    )

    const xai = listAccounts().find((a) => a.label === "xai-export")
    expect(xai?.provider).toBe("xai")
    if (!xai) throw new Error("xai account missing")
    expect(isOAuthAccount(xai) && xai.credentials?.accessToken).toBe(
      "xai-access",
    )
    expect(isOAuthAccount(xai) && xai.settings?.proxyUrl).toBe(
      "http://127.0.0.1:7891",
    )

    const antigravity = listAccounts().find(
      (a) => a.label === "antigravity-export",
    )
    expect(antigravity?.provider).toBe("antigravity")
    if (!antigravity) throw new Error("antigravity account missing")
    expect(isOAuthAccount(antigravity) && antigravity.credentials?.apiKey).toBe(
      "antigravity-key",
    )
  })

  test("POST /admin/api/accounts/import reports OAuth account missing token", async () => {
    const response = await adminJson(
      "http://localhost/admin/api/accounts/import",
      {
        method: "POST",
        body: JSON.stringify({
          accounts: [
            {
              label: "xai-missing-token",
              provider: "xai",
              credentials: {},
              settings: {},
            },
          ],
        }),
      },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      imported: number
      failed: number
      details: { failed: Array<{ label: string; reason: string }> }
    }
    expect(body.imported).toBe(0)
    expect(body.failed).toBe(1)
    expect(body.details.failed[0]?.label).toBe("xai-missing-token")
    expect(body.details.failed[0]?.reason).toContain(
      "Missing accessToken or apiKey",
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
    setTestAccounts([claudeAccount])

    const routing = resolveModelRouting("work/claude-sonnet-4-6")
    expect(routing.accountPrefix).toBe("work")
    expect(routing.modelId).toBe("claude-sonnet-4-6")

    const targets = buildRouteTargets({
      legacyProvider: "claude",
      publicModelId: "work/claude-sonnet-4-6",
      endpoint: "messages",
    })
    expect(targets).toHaveLength(1)
    expect(targets[0]?.connectionId).toBe("claude-smoke")
  })
})
