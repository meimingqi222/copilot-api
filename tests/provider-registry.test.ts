import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { ensureDirectProviderAccounts } from "~/lib/provider-defaults"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { cacheModels } from "~/lib/utils"
import { server } from "~/server"
import { initializeProviderRegistry } from "~/services/providers"

const originalAccounts = state.accounts
const originalActiveAccountIndex = state.activeAccountIndex
const originalModels = state.models
const originalApiKey = state.legacyApiKey
const originalProviderDefaults = structuredClone(state.providerDefaults)
const originalAccountsPath = PATHS.ACCOUNTS_PATH
const testAccountsPath = path.join(
  process.cwd(),
  ".tmp-provider-registry-accounts.json",
)

beforeEach(() => {
  initializeProviderRegistry()
  statsStore.clearUsageStatsForTest()
  state.accounts = []
  state.activeAccountIndex = 0
  state.models = undefined
  state.legacyApiKey = undefined
  state.providerDefaults = structuredClone(originalProviderDefaults)
  PATHS.ACCOUNTS_PATH = testAccountsPath
})

afterEach(async () => {
  state.accounts = originalAccounts
  state.activeAccountIndex = originalActiveAccountIndex
  state.models = originalModels
  state.legacyApiKey = originalApiKey
  state.providerDefaults = structuredClone(originalProviderDefaults)
  PATHS.ACCOUNTS_PATH = originalAccountsPath
  resetAdaptiveRateLimiterForTest()
  await fs.rm(testAccountsPath, { force: true }).catch(() => undefined)
})

test("cacheModels keeps provider-qualified duplicates visible", () => {
  state.accounts = [
    {
      id: "copilot-1",
      label: "copilot",
      provider: "copilot",
      credentials: { githubToken: "gh-token" },
      settings: {},
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
      availableModels: [
        {
          id: "swe-1-6-fast",
          name: "swe-1-6-fast",
          vendor: "OpenAI",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions"],
          provider: "copilot",
        },
      ],
    },
    {
      id: "windsurf-1",
      label: "windsurf",
      provider: "windsurf",
      credentials: { apiKey: "ws-key" },
      settings: { defaultModel: "swe-1-6-fast" },
      enabled: true,
      priority: 1,
      isExhausted: false,
      createdAt: Date.now(),
      availableModels: [
        {
          id: "swe-1-6-fast",
          name: "SWE-1.6 Fast",
          vendor: "Windsurf",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions", "/v1/messages"],
          provider: "windsurf",
        },
      ],
    },
  ]

  cacheModels()

  const modelIds = state.models?.data.map((model) => model.id) ?? []
  expect(modelIds.includes("swe-1-6-fast")).toBe(true)
  expect(modelIds.includes("copilot/swe-1-6-fast")).toBe(true)
  expect(modelIds.includes("windsurf/swe-1-6-fast")).toBe(true)
})

test("ensureDirectProviderAccounts reapplies CLI defaults to managed direct accounts", async () => {
  state.providerDefaults.codebuff.authToken = "cb-token"
  state.providerDefaults.codebuff.baseUrl = "https://override.example"
  state.providerDefaults.codebuff.cliVersion = "9.9.9"
  state.providerDefaults.codebuff.agentId = "agent-override"
  state.providerDefaults.codebuff.model = "gpt-override"
  state.providerDefaults.codebuff.costMode = "cheap"
  state.providerDefaults.codebuff.allowFallbacks = false

  state.accounts = [
    {
      id: "codebuff-default",
      label: "codebuff-default",
      provider: "codebuff",
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
      credentials: { authToken: "cb-token" },
      settings: {
        baseUrl: "https://stale.example",
        cliVersion: "0.0.1",
        agentId: "stale-agent",
        model: "stale-model",
        costMode: "normal",
        allowFallbacks: true,
      },
    },
  ]

  await ensureDirectProviderAccounts()

  expect(state.accounts[0]?.settings).toMatchObject({
    baseUrl: "https://override.example",
    cliVersion: "9.9.9",
    agentId: "agent-override",
    model: "gpt-override",
    costMode: "cheap",
    allowFallbacks: false,
  })
})

test("GET /admin/api/providers returns registered provider descriptors", async () => {
  const response = await server.fetch(
    new Request("http://localhost/admin/api/providers"),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    providers: Array<{ id: string; authMode: string }>
  }
  const providerIds = new Set(body.providers.map((provider) => provider.id))
  expect(providerIds.has("copilot")).toBe(true)
  expect(providerIds.has("codebuff")).toBe(true)
  expect(providerIds.has("windsurf")).toBe(true)
  expect(
    body.providers.find((provider) => provider.id === "copilot")?.authMode,
  ).toBe("device_flow")
})

test("POST /admin/api/accounts creates a windsurf account with direct credentials", async () => {
  const response = await server.fetch(
    new Request("http://localhost/admin/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "windsurf-main",
        provider: "windsurf",
        credentials: {
          apiKey: "ws-test-key",
        },
        settings: {
          defaultModel: "swe-1-6-fast",
        },
      }),
    }),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    status: string
    account: { provider: string; label: string }
  }

  expect(body.status).toBe("complete")
  expect(body.account.provider).toBe("windsurf")
  expect(body.account.label).toBe("windsurf-main")
  expect(
    state.accounts.some((account) => account.provider === "windsurf"),
  ).toBe(true)
})
