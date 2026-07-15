import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Account } from "~/lib/accounts"

import { loadAccounts, saveAccounts } from "~/lib/account-store"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { __resetProviderConnectionsForTest } from "~/lib/provider-connections"
import { state } from "~/lib/state"

import { setTestAccounts } from "./helpers/set-accounts"

/**
 * 读取 provider-connections.json 并返回 connections 数组。
 */
async function readProviderConnectionsFile(): Promise<
  Array<Record<string, unknown>>
> {
  const raw = await fs.readFile(PATHS.PROVIDER_CONNECTIONS_PATH)
  const parsed = JSON.parse(raw.toString("utf8")) as {
    connections: Array<Record<string, unknown>>
  }
  return parsed.connections
}

describe("account-store", () => {
  const isolationRoot = PATHS.APP_DIR
  let tempAppDir: string

  beforeEach(async () => {
    tempAppDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `accounts-store-test-${randomUUID()}-`),
    )
    redirectPathsToDir(tempAppDir)
    setTestAccounts([])
    __resetProviderConnectionsForTest()
  })

  afterEach(async () => {
    redirectPathsToDir(isolationRoot)
    __resetProviderConnectionsForTest()
    await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
  })

  test("saveAccounts uses Promise queue lock to serialize writes", async () => {
    const acc1: Account = {
      id: "1",
      label: "acc-1",
      provider: "copilot",
      credentials: { githubToken: "token-1" },
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
    }
    const acc2: Account = {
      id: "2",
      label: "acc-2",
      provider: "copilot",
      credentials: { githubToken: "token-2" },
      enabled: true,
      priority: 1,
      quotaState: "unknown",
      createdAt: Date.now(),
    }

    setTestAccounts([acc1])
    const p1 = saveAccounts()
    setTestAccounts([acc1, acc2])
    const p2 = saveAccounts()

    await Promise.all([p1, p2])

    const connections = await readProviderConnectionsFile()
    expect(connections).toHaveLength(2)
    expect(connections[1]?.id).toBe("2")
  })

  test("loadAccounts restores cooldownUntil and syncs legacy state", async () => {
    const cooldownTime = Date.now() + 100000
    const acc: Account = {
      id: "1",
      label: "acc-1",
      provider: "copilot",
      credentials: { githubToken: "token-1" },
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      cooldownUntil: cooldownTime,
    }
    setTestAccounts([acc])
    await saveAccounts()

    setTestAccounts([])
    __resetProviderConnectionsForTest()
    await loadAccounts()

    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0].cooldownUntil).toBe(cooldownTime)
  })

  test("loadAccounts migrates legacy flat fields into credentials/settings", async () => {
    const legacyAccounts = [
      {
        id: "legacy-copilot",
        label: "legacy-copilot",
        provider: "copilot",
        githubToken: "gh-legacy",
        copilotToken: "cp-legacy",
        copilotTokenExpiry: 1234567890,
        enabled: true,
        priority: 0,
        createdAt: 1000,
      },
      {
        id: "legacy-codebuff",
        label: "legacy-codebuff",
        provider: "codebuff",
        codebuffAuthToken: "cb-legacy",
        codebuffBaseUrl: "https://legacy.codebuff.com",
        codebuffCliVersion: "1.0.0",
        codebuffAgentId: "legacy-agent",
        codebuffModel: "legacy-model",
        codebuffCostMode: "fast",
        codebuffAllowFallbacks: false,
        enabled: true,
        priority: 1,
        createdAt: 2000,
      },
      {
        id: "legacy-windsurf",
        label: "legacy-windsurf",
        provider: "windsurf",
        windsurfApiKey: "ws-legacy",
        windsurfBaseUrl: "https://legacy.windsurf.com",
        windsurfDefaultModel: "swe-legacy",
        enabled: true,
        priority: 2,
        createdAt: 3000,
      },
    ]
    await fs.writeFile(
      PATHS.ACCOUNTS_PATH,
      JSON.stringify(legacyAccounts),
      "utf8",
    )

    await loadAccounts()

    // accounts.json should be renamed after migration
    let accountsJsonExists = false
    try {
      await fs.readFile(PATHS.ACCOUNTS_PATH, "utf8")
      accountsJsonExists = true
    } catch {
      // expected — accounts.json was renamed
    }
    expect(accountsJsonExists).toBe(false)

    expect(state.accounts).toHaveLength(3)

    const copilot = state.accounts[0]
    expect(copilot.provider).toBe("copilot")
    expect(copilot.credentials?.githubToken).toBe("gh-legacy")
    expect(copilot.runtimeState?.copilotToken).toBe("cp-legacy")
    expect(copilot.runtimeState?.copilotTokenExpiry).toBe(1234567890)

    const codebuff = state.accounts[1]
    expect(codebuff.provider).toBe("codebuff")
    expect(codebuff.credentials?.authToken).toBe("cb-legacy")
    expect(codebuff.settings).toMatchObject({
      baseUrl: "https://legacy.codebuff.com",
      cliVersion: "1.0.0",
      agentId: "legacy-agent",
      model: "legacy-model",
      costMode: "fast",
      allowFallbacks: false,
    })

    const windsurf = state.accounts[2]
    expect(windsurf.provider).toBe("windsurf")
    expect(windsurf.credentials?.apiKey).toBe("ws-legacy")
    expect(windsurf.settings).toMatchObject({
      baseUrl: "https://legacy.windsurf.com",
      defaultModel: "swe-legacy",
    })

    // provider-connections.json should exist with migrated data
    const connections = await readProviderConnectionsFile()
    expect(connections).toHaveLength(3)
  })

  test("loadAccounts migrates legacy mimo proxy and windsurf jwt runtime state", async () => {
    const legacyAccounts = [
      {
        id: "legacy-mimo",
        label: "legacy-mimo",
        provider: "mimo-aistudio",
        serviceToken: "svc-legacy",
        xiaomichatbotPh: "ph-legacy",
        mimoWsToken: "ws-legacy",
        userId: "user-legacy",
        proxy: "http://proxy.example:8080",
        enabled: true,
        priority: 0,
        createdAt: 1000,
      },
      {
        id: "legacy-windsurf-jwt",
        label: "legacy-windsurf-jwt",
        provider: "windsurf",
        windsurfApiKey: "ws-key",
        windsurfJwt: "jwt-legacy",
        windsurfJwtFetchedAt: 9876543210,
        enabled: true,
        priority: 1,
        createdAt: 2000,
      },
    ]
    await fs.writeFile(
      PATHS.ACCOUNTS_PATH,
      JSON.stringify(legacyAccounts),
      "utf8",
    )

    await loadAccounts()

    const mimo = state.accounts[0]
    expect(mimo.provider).toBe("mimo-aistudio")
    expect(mimo.credentials?.serviceToken).toBe("svc-legacy")
    expect(mimo.credentials?.xiaomichatbotPh).toBe("ph-legacy")
    expect(mimo.credentials?.mimoWsToken).toBe("ws-legacy")
    expect(mimo.settings).toMatchObject({
      userId: "user-legacy",
      proxy: "http://proxy.example:8080",
    })

    const windsurf = state.accounts[1]
    expect(windsurf.provider).toBe("windsurf")
    expect(windsurf.runtimeState?.windsurfJwt).toBe("jwt-legacy")
    expect(windsurf.runtimeState?.windsurfJwtFetchedAt).toBe(9876543210)

    // provider-connections.json should have the data
    const connections = await readProviderConnectionsFile()
    expect(connections).toHaveLength(2)
  })

  test("loadAccounts resets expired cooldownUntil", async () => {
    const expiredCooldownTime = Date.now() - 10000
    const acc: Account = {
      id: "1",
      label: "acc-1",
      provider: "copilot",
      credentials: { githubToken: "token-1" },
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      cooldownUntil: expiredCooldownTime,
    }
    setTestAccounts([acc])
    await saveAccounts()

    setTestAccounts([])
    __resetProviderConnectionsForTest()
    await loadAccounts()

    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0].cooldownUntil).toBeUndefined()
  })

  test("loadAccounts preserves an intentionally empty accounts file", async () => {
    await fs.writeFile(PATHS.ACCOUNTS_PATH, "[]", "utf8")
    await fs.writeFile(PATHS.GITHUB_TOKEN_PATH, "legacy-token", "utf8")

    await loadAccounts()

    // Empty accounts.json triggers first migration (0 accounts → 0 connections)
    // accounts.json is renamed, legacy token creates a copilot account
    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0].provider).toBe("copilot")
  })

  test("loadAccounts does not overwrite corrupt accounts with legacy default", async () => {
    await fs.writeFile(PATHS.ACCOUNTS_PATH, "not-json", "utf8")
    await fs.writeFile(PATHS.GITHUB_TOKEN_PATH, "legacy-token", "utf8")

    let thrown: unknown
    try {
      await loadAccounts()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("Could not recover accounts")

    expect(state.accounts).toHaveLength(0)
  })

  test("loadAccounts preserves OAuth tokenEndpoint and redirectUri", async () => {
    setTestAccounts([
      {
        id: "xai-1",
        label: "xai-account",
        provider: "xai",
        enabled: true,
        priority: 0,
        quotaState: "unknown",
        createdAt: Date.now(),
        credentials: {
          accessToken: "xai-access",
          refreshToken: "xai-refresh",
        },
        settings: {
          tokenEndpoint: "https://auth.x.ai/oauth/token",
          redirectUri: "http://127.0.0.1:56121/callback",
          proxyUrl: "http://127.0.0.1:7890",
        },
      },
    ])
    await saveAccounts()

    setTestAccounts([])
    __resetProviderConnectionsForTest()
    await loadAccounts()

    expect(state.accounts).toHaveLength(1)
    const loaded = state.accounts[0]
    expect(loaded.provider).toBe("xai")
    expect(loaded.settings?.tokenEndpoint).toBe("https://auth.x.ai/oauth/token")
    expect(loaded.settings?.redirectUri).toBe("http://127.0.0.1:56121/callback")
    expect(loaded.settings?.proxyUrl).toBe("http://127.0.0.1:7890")
  })

  test("saveAccounts refuses empty snapshot when connections exist", async () => {
    const acc: Account = {
      id: "1",
      label: "ws",
      provider: "windsurf",
      credentials: { apiKey: "key" },
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
    }
    setTestAccounts([acc])
    await saveAccounts()

    setTestAccounts([])
    await saveAccounts()

    // Should refuse to persist empty (connections still has 1 entry)
    const connections = await readProviderConnectionsFile()
    expect(connections).toHaveLength(1)
  })

  test("saveAccounts does not persist runtimeState tokens at top level", async () => {
    const acc: Account = {
      id: "1",
      label: "acc-1",
      provider: "copilot",
      credentials: { githubToken: "token-1" },
      runtimeState: {
        copilotToken: "secret-cp-token",
        copilotTokenExpiry: 9999999999,
      },
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
    }
    setTestAccounts([acc])
    await saveAccounts()

    const connections = await readProviderConnectionsFile()
    // runtimeState is not a top-level field in provider-connections.json
    expect(connections[0]).not.toHaveProperty("runtimeState")
    // githubToken should be in credential.context
    const conn0 = connections[0]
    const credentials = conn0.credentials as Array<Record<string, unknown>>
    const cred = credentials[0]
    const ctx = cred.context as Record<string, unknown>
    expect(ctx.githubToken).toBe("token-1")
    // copilotToken is in credential.value (runtime token)
    expect(cred.value).toBe("secret-cp-token")
  })

  test("saveAccounts allowEmpty persists cleared account list", async () => {
    const acc: Account = {
      id: "1",
      label: "ws",
      provider: "windsurf",
      credentials: { apiKey: "key" },
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
    }
    setTestAccounts([acc])
    await saveAccounts()

    setTestAccounts([])
    await saveAccounts({ allowEmpty: true })

    const connections = await readProviderConnectionsFile()
    expect(connections).toEqual([])
  })
})
