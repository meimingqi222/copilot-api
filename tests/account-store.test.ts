import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Account } from "~/lib/legacy-accounts"

import { loadAccounts, saveAccounts } from "~/lib/account-store"
import { listAccounts } from "~/lib/legacy-accounts"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { __resetProviderConnectionsForTest } from "~/lib/provider-connections"

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

    expect(listAccounts()).toHaveLength(1)
    expect(listAccounts()[0].cooldownUntil).toBe(cooldownTime)
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

    expect(listAccounts()).toHaveLength(3)

    const copilot = listAccounts()[0]
    expect(copilot.provider).toBe("copilot")
    expect(copilot.credentials?.githubToken).toBe("gh-legacy")
    expect(copilot.runtimeState?.copilotToken).toBe("cp-legacy")
    expect(copilot.runtimeState?.copilotTokenExpiry).toBe(1234567890)

    const codebuff = listAccounts()[1]
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

    const windsurf = listAccounts()[2]
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

    const mimo = listAccounts()[0]
    expect(mimo.provider).toBe("mimo-aistudio")
    expect(mimo.credentials?.serviceToken).toBe("svc-legacy")
    expect(mimo.credentials?.xiaomichatbotPh).toBe("ph-legacy")
    expect(mimo.credentials?.mimoWsToken).toBe("ws-legacy")
    expect(mimo.settings).toMatchObject({
      userId: "user-legacy",
      proxy: "http://proxy.example:8080",
    })

    const windsurf = listAccounts()[1]
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

    expect(listAccounts()).toHaveLength(1)
    expect(listAccounts()[0].cooldownUntil).toBeUndefined()
  })

  test("loadAccounts preserves an intentionally empty accounts file", async () => {
    await fs.writeFile(PATHS.ACCOUNTS_PATH, "[]", "utf8")
    await fs.writeFile(PATHS.GITHUB_TOKEN_PATH, "legacy-token", "utf8")

    await loadAccounts()

    // Empty accounts.json triggers first migration (0 accounts → 0 connections)
    // accounts.json is renamed, legacy token creates a copilot account
    expect(listAccounts()).toHaveLength(1)
    expect(listAccounts()[0].provider).toBe("copilot")
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

    expect(listAccounts()).toHaveLength(0)
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

    expect(listAccounts()).toHaveLength(1)
    const loaded = listAccounts()[0]
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

  // ── Phase 5 boot-migration 测试 ──

  test("loadAccounts: connections take priority when accounts.json also exists", async () => {
    // 先创建 provider-connections.json(已有 connections)
    const acc: Account = {
      id: "existing-conn",
      label: "existing-connection",
      provider: "copilot",
      credentials: { githubToken: "token-existing" },
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
    }
    setTestAccounts([acc])
    await saveAccounts()

    // 再写入 accounts.json(应被忽略,connections 优先)
    await fs.writeFile(
      PATHS.ACCOUNTS_PATH,
      JSON.stringify([
        {
          id: "from-accounts-json",
          label: "from-accounts-json",
          provider: "copilot",
          githubToken: "token-from-accounts",
          enabled: true,
          priority: 0,
          createdAt: 1000,
        },
      ]),
      "utf8",
    )

    __resetProviderConnectionsForTest()
    await loadAccounts()

    // 应加载 provider-connections.json 中的 connection,而非 accounts.json
    expect(listAccounts()).toHaveLength(1)
    expect(listAccounts()[0].id).toBe("existing-conn")
    expect(listAccounts()[0].label).toBe("existing-connection")

    // accounts.json 应仍然存在(未被改名,因为 connections 优先时不改名)
    let accountsJsonExists = false
    try {
      await fs.readFile(PATHS.ACCOUNTS_PATH, "utf8")
      accountsJsonExists = true
    } catch {
      // expected
    }
    expect(accountsJsonExists).toBe(true)
  })

  test("loadAccounts: first migration renames accounts.json to .migrated-*.bak", async () => {
    const legacyAccounts = [
      {
        id: "migrate-test-1",
        label: "migrate-test",
        provider: "copilot",
        githubToken: "gh-migrate",
        enabled: true,
        priority: 0,
        createdAt: 1000,
      },
    ]
    await fs.writeFile(
      PATHS.ACCOUNTS_PATH,
      JSON.stringify(legacyAccounts),
      "utf8",
    )

    await loadAccounts()

    // accounts.json 应被改名为 .migrated-*.bak
    let accountsJsonExists = false
    try {
      await fs.readFile(PATHS.ACCOUNTS_PATH, "utf8")
      accountsJsonExists = true
    } catch {
      // expected — accounts.json was renamed
    }
    expect(accountsJsonExists).toBe(false)

    // 应存在 .migrated-*.bak 文件
    const dir = path.dirname(PATHS.ACCOUNTS_PATH)
    const files = await fs.readdir(dir)
    const bakFiles = files.filter(
      (f) => f.includes(".migrated-") && f.endsWith(".bak"),
    )
    expect(bakFiles.length).toBeGreaterThanOrEqual(1)

    // 迁移后的数据应正确加载
    expect(listAccounts()).toHaveLength(1)
    expect(listAccounts()[0].id).toBe("migrate-test-1")
    expect(listAccounts()[0].credentials?.githubToken).toBe("gh-migrate")
  })

  test("loadAccounts: COPILOT_API_FORCE_REMIGRATE=1 re-migrates and merges by id", async () => {
    // 1. 先创建 provider-connections.json(已有 1 个 connection)
    const existingAcc: Account = {
      id: "keep-existing",
      label: "existing-conn",
      provider: "copilot",
      credentials: { githubToken: "token-existing" },
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
    }
    setTestAccounts([existingAcc])
    await saveAccounts()

    // 2. 写入 accounts.json(包含 1 个同 id + 1 个新 id)
    await fs.writeFile(
      PATHS.ACCOUNTS_PATH,
      JSON.stringify([
        {
          id: "keep-existing",
          label: "re-migrated-label",
          provider: "copilot",
          githubToken: "gh-remigrated",
          enabled: true,
          priority: 5,
          createdAt: 2000,
        },
        {
          id: "new-from-accounts",
          label: "new-account",
          provider: "copilot",
          githubToken: "gh-new",
          enabled: true,
          priority: 10,
          createdAt: 3000,
        },
      ]),
      "utf8",
    )

    // 3. 设置 FORCE_REMIGRATE=1 并重新加载
    const originalEnv = process.env.COPILOT_API_FORCE_REMIGRATE
    process.env.COPILOT_API_FORCE_REMIGRATE = "1"
    try {
      __resetProviderConnectionsForTest()
      await loadAccounts()

      // 应合并:同 id 的被 accounts.json 覆盖,新 id 的被添加
      const accounts = listAccounts()
      expect(accounts).toHaveLength(2)

      const existing = accounts.find((a) => a.id === "keep-existing")
      expect(existing).toBeDefined()
      // force re-migration 后 label 应来自 accounts.json
      expect(existing?.label).toBe("re-migrated-label")
      expect(existing?.credentials?.githubToken).toBe("gh-remigrated")

      const newAcc = accounts.find((a) => a.id === "new-from-accounts")
      expect(newAcc).toBeDefined()
      expect(newAcc?.label).toBe("new-account")
      expect(newAcc?.credentials?.githubToken).toBe("gh-new")
    } finally {
      if (originalEnv === undefined) {
        delete process.env.COPILOT_API_FORCE_REMIGRATE
      } else {
        process.env.COPILOT_API_FORCE_REMIGRATE = originalEnv
      }
    }
  })
})
