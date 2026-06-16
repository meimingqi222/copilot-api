import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Account } from "~/lib/accounts"

import { saveAccounts, loadAccounts } from "~/lib/account-store"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

describe("account-store", () => {
  const originalPath = PATHS.ACCOUNTS_PATH
  let tempAccountsPath: string

  beforeEach(() => {
    tempAccountsPath = path.join(
      os.tmpdir(),
      `accounts-test-${randomUUID()}.json`,
    )
    PATHS.ACCOUNTS_PATH = tempAccountsPath
    state.accounts = []
  })

  afterEach(async () => {
    PATHS.ACCOUNTS_PATH = originalPath
    try {
      await fs.unlink(tempAccountsPath)
    } catch {
      // ignore
    }
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

    state.accounts = [acc1]
    const p1 = saveAccounts()
    state.accounts = [acc1, acc2]
    const p2 = saveAccounts()

    await Promise.all([p1, p2])

    const fileContent = await fs.readFile(tempAccountsPath)
    const parsed = JSON.parse(fileContent as unknown as string) as Array<
      Record<string, unknown>
    >
    expect(parsed).toHaveLength(2)
    expect(parsed[1]?.id).toBe("2")
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
    state.accounts = [acc]
    await saveAccounts()

    state.accounts = []
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
    await fs.writeFile(tempAccountsPath, JSON.stringify(legacyAccounts), "utf8")

    await loadAccounts()

    const savedAfterLoad = JSON.parse(
      (await fs.readFile(tempAccountsPath)).toString("utf8"),
    ) as Array<Record<string, unknown>>
    expect(savedAfterLoad[0]).not.toHaveProperty("githubToken")

    expect(state.accounts).toHaveLength(3)

    const copilot = state.accounts[0]
    expect(copilot.provider).toBe("copilot")
    if (copilot.provider === "copilot") {
      expect(copilot.credentials?.githubToken).toBe("gh-legacy")
      expect(copilot.runtimeState?.copilotToken).toBe("cp-legacy")
      expect(copilot.runtimeState?.copilotTokenExpiry).toBe(1234567890)
      expect("githubToken" in copilot).toBe(false)
      expect("copilotToken" in copilot).toBe(false)
    }

    const codebuff = state.accounts[1]
    expect(codebuff.provider).toBe("codebuff")
    if (codebuff.provider === "codebuff") {
      expect(codebuff.credentials?.authToken).toBe("cb-legacy")
      expect(codebuff.settings).toMatchObject({
        baseUrl: "https://legacy.codebuff.com",
        cliVersion: "1.0.0",
        agentId: "legacy-agent",
        model: "legacy-model",
        costMode: "fast",
        allowFallbacks: false,
      })
      expect("codebuffAuthToken" in codebuff).toBe(false)
    }

    const windsurf = state.accounts[2]
    expect(windsurf.provider).toBe("windsurf")
    if (windsurf.provider === "windsurf") {
      expect(windsurf.credentials?.apiKey).toBe("ws-legacy")
      expect(windsurf.settings).toMatchObject({
        baseUrl: "https://legacy.windsurf.com",
        defaultModel: "swe-legacy",
      })
      expect("windsurfApiKey" in windsurf).toBe(false)
    }

    await saveAccounts()
    const saved = JSON.parse(
      (await fs.readFile(tempAccountsPath)).toString("utf8"),
    ) as Array<Record<string, unknown>>
    expect(saved[0]).not.toHaveProperty("githubToken")
    expect(saved[0]).not.toHaveProperty("copilotToken")
    expect(saved[1]).not.toHaveProperty("codebuffAuthToken")
    expect(saved[2]).not.toHaveProperty("windsurfApiKey")
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
    await fs.writeFile(tempAccountsPath, JSON.stringify(legacyAccounts), "utf8")

    await loadAccounts()

    const mimo = state.accounts[0]
    expect(mimo.provider).toBe("mimo-aistudio")
    if (mimo.provider === "mimo-aistudio") {
      expect(mimo.credentials?.serviceToken).toBe("svc-legacy")
      expect(mimo.credentials?.xiaomichatbotPh).toBe("ph-legacy")
      expect(mimo.credentials?.mimoWsToken).toBe("ws-legacy")
      expect(mimo.settings).toMatchObject({
        userId: "user-legacy",
        proxy: "http://proxy.example:8080",
      })
    }

    const windsurf = state.accounts[1]
    expect(windsurf.provider).toBe("windsurf")
    if (windsurf.provider === "windsurf") {
      expect(windsurf.runtimeState?.windsurfJwt).toBe("jwt-legacy")
      expect(windsurf.runtimeState?.windsurfJwtFetchedAt).toBe(9876543210)
    }

    await saveAccounts()
    const saved = JSON.parse(
      (await fs.readFile(tempAccountsPath)).toString("utf8"),
    ) as Array<Record<string, unknown>>
    expect(saved[0]).not.toHaveProperty("serviceToken")
    expect(saved[0]).not.toHaveProperty("xiaomichatbotPh")
    expect(saved[0]).not.toHaveProperty("userId")
    expect(saved[0]).not.toHaveProperty("proxy")
    expect(saved[1]).not.toHaveProperty("windsurfJwt")
    expect(saved[1]).not.toHaveProperty("windsurfJwtFetchedAt")
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
    state.accounts = [acc]
    await saveAccounts()

    state.accounts = []
    await loadAccounts()

    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0].cooldownUntil).toBeUndefined()
  })
})
