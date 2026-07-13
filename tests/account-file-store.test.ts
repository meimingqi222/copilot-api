import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  tryReadAccountsFile,
  writeAccountsFile,
} from "~/lib/account-file-store"
import { PATHS, redirectPathsToDir } from "~/lib/paths"

describe("tryReadAccountsFile", () => {
  const isolationRoot = PATHS.APP_DIR
  let tempAppDir: string
  let tempAccountsPath: string

  beforeEach(async () => {
    tempAppDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `accounts-file-test-${randomUUID()}-`),
    )
    redirectPathsToDir(tempAppDir)
    tempAccountsPath = PATHS.ACCOUNTS_PATH
  })

  afterEach(async () => {
    redirectPathsToDir(isolationRoot)
    await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
  })

  test("refuses writing empty array when .bak has accounts", async () => {
    const backupAccount = {
      id: "acc-1",
      label: "ws",
      provider: "windsurf",
      enabled: true,
      priority: 0,
      credentials: { apiKey: "key" },
      settings: {},
      createdAt: Date.now(),
    }
    await fs.writeFile(
      `${tempAccountsPath}.bak`,
      JSON.stringify([backupAccount]),
      "utf8",
    )
    await fs.writeFile(
      tempAccountsPath,
      JSON.stringify([backupAccount]),
      "utf8",
    )

    await writeAccountsFile([])

    const saved = JSON.parse(
      (await fs.readFile(tempAccountsPath)).toString("utf8"),
    ) as Array<Record<string, unknown>>
    expect(saved).toHaveLength(1)
  })

  test("refuses shrinking many accounts down to one", async () => {
    const accounts = Array.from({ length: 4 }, (_, index) => ({
      id: `acc-${index}`,
      label: `acc-${index}`,
      provider: "copilot",
      enabled: true,
      priority: 0,
      credentials: { githubToken: `token-${index}` },
      settings: {},
      createdAt: Date.now(),
    }))
    await fs.writeFile(tempAccountsPath, JSON.stringify(accounts), "utf8")

    await writeAccountsFile([accounts[0]])

    const saved = JSON.parse(
      (await fs.readFile(tempAccountsPath)).toString("utf8"),
    ) as Array<Record<string, unknown>>
    expect(saved).toHaveLength(4)
  })

  test("recovers empty primary file from non-empty .bak", async () => {
    const backupAccount = {
      id: "acc-1",
      label: "ws",
      provider: "windsurf",
      enabled: true,
      priority: 0,
      credentials: { apiKey: "key" },
      settings: {},
      createdAt: Date.now(),
    }
    await fs.writeFile(
      `${tempAccountsPath}.bak`,
      JSON.stringify([backupAccount]),
      "utf8",
    )
    await fs.writeFile(tempAccountsPath, "[]", "utf8")

    const result = await tryReadAccountsFile()

    expect(result.status).toBe("found")
    if (result.status === "found") {
      expect(result.accounts).toHaveLength(1)
      expect(result.accounts[0]?.label).toBe("ws")
    }
  })
})
