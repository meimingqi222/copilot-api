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
