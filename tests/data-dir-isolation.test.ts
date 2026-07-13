import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { writeAccountsFile } from "~/lib/account-file-store"
import { saveAccounts } from "~/lib/account-store"
import {
  assertWritableDataPath,
  isProductionDataPath,
  isTestDataIsolationEnabled,
  PATHS,
  PRODUCTION_APP_DIR,
  redirectPathsToDir,
} from "~/lib/paths"
import { state } from "~/lib/state"

describe("test data-dir isolation", () => {
  const isolationDirAtLoad = PATHS.APP_DIR

  afterEach(() => {
    // Keep suite on the preload isolation root (not production).
    if (!isProductionDataPath(isolationDirAtLoad)) {
      redirectPathsToDir(isolationDirAtLoad)
    }
  })

  test("preload enables isolation and points PATHS off production", () => {
    expect(isTestDataIsolationEnabled()).toBe(true)
    expect(isProductionDataPath(PATHS.APP_DIR)).toBe(false)
    expect(isProductionDataPath(PATHS.ACCOUNTS_PATH)).toBe(false)
    expect(PATHS.ACCOUNTS_PATH.startsWith(PRODUCTION_APP_DIR)).toBe(false)
  })

  test("assertWritableDataPath blocks production accounts.json", () => {
    expect(() =>
      assertWritableDataPath(path.join(PRODUCTION_APP_DIR, "accounts.json")),
    ).toThrow(/Refusing to write production data path during tests/)
  })

  test("PATHS.ACCOUNTS_PATH assignment is not allowed", () => {
    expect(() => {
      // @ts-expect-error PATHS keys are read-only getters
      PATHS.ACCOUNTS_PATH = path.join(PRODUCTION_APP_DIR, "accounts.json")
    }).toThrow()
  })

  test("redirectPathsToDir refuses production under isolation", () => {
    expect(() => redirectPathsToDir(PRODUCTION_APP_DIR)).toThrow(
      /Refusing to redirect PATHS to production/,
    )
  })

  test("writeAccountsFile only ever targets current isolation tree", async () => {
    const productionAccounts = path.join(PRODUCTION_APP_DIR, "accounts.json")
    const before =
      (await fs.readFile(productionAccounts, "utf8").catch(() => null)) ?? null

    await writeAccountsFile([
      {
        id: "should-not-land",
        label: "pollution",
        provider: "copilot",
        enabled: true,
        priority: 0,
        credentials: { githubToken: "nope" },
        settings: {},
        createdAt: Date.now(),
      },
    ])

    expect(isProductionDataPath(PATHS.ACCOUNTS_PATH)).toBe(false)
    const after =
      (await fs.readFile(productionAccounts, "utf8").catch(() => null)) ?? null
    expect(after).toBe(before)
  })

  test("saveAccounts writes only under the isolation directory", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "copilot-api-isolation-"),
    )
    redirectPathsToDir(tempDir)
    state.accounts = [
      {
        id: randomUUID(),
        label: "isolated-only",
        provider: "windsurf",
        credentials: { apiKey: "ws-test" },
        settings: {},
        enabled: true,
        priority: 0,
        isExhausted: false,
        createdAt: Date.now(),
      },
    ]

    await saveAccounts()

    const written = await fs.readFile(PATHS.ACCOUNTS_PATH, "utf8")
    expect(written).toContain("isolated-only")
    expect(isProductionDataPath(PATHS.ACCOUNTS_PATH)).toBe(false)

    const productionRaw = await fs
      .readFile(path.join(PRODUCTION_APP_DIR, "accounts.json"), "utf8")
      .catch(() => "")
    expect(productionRaw).not.toContain("isolated-only")
  })
})
