/**
 * Regression tests for the standard (non-OAuth) account import path
 * `POST /admin/api/accounts/import`.
 *
 * The per-provider branches were extracted into `buildProviderAccount` /
 * `initializeImportedAccount` to bring the route handler under the lint
 * complexity limit. These tests pin the observable contract of each branch so
 * the extraction cannot silently drop a credential field or change a failure
 * reason.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { Account } from "~/lib/legacy-accounts"

import { listAccounts } from "~/lib/legacy-accounts"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import { cancelAllCodebuddyRefreshTimers } from "~/services/codebuddy/token-refresh"
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
const testRoot = path.join(process.cwd(), ".tmp-admin-account-import")
let testDir = testRoot
let testCounter = 0

async function adminJson(url: string, init?: RequestInit): Promise<Response> {
  const headers = adminHeaders(init?.headers)
  headers.set("content-type", "application/json")
  return await server.fetch(new Request(url, { ...init, headers }))
}

async function importAccounts(accounts: Array<Record<string, unknown>>) {
  const response = await adminJson(
    "http://localhost/admin/api/accounts/import",
    { method: "POST", body: JSON.stringify({ accounts }) },
  )
  return {
    status: response.status,
    body: (await response.json()) as {
      imported: number
      skipped: number
      failed: number
      details: {
        imported: Array<string>
        skipped: Array<string>
        failed: Array<{ label: string; reason: string }>
      }
    },
  }
}

/** Every model refresh is a network call; 404 keeps the suite offline. */
function offlineFetch(): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("{}", { status: 404 }),
    )) as unknown as typeof fetch
}

beforeEach(async () => {
  // Unique subdir per test so a background saveAccounts() from the previous
  // test never writes into a directory this test is about to delete.
  testCounter += 1
  testDir = path.join(testRoot, `t${testCounter}`)
  await fs.mkdir(testDir, { recursive: true })
  redirectPathsToDir(testDir)
  initializeProviderRegistry()
  statsStore.clearUsageStatsForTest()
  setTestAccounts([])
  state.users = []
  clearAdminPasswordConfig()
  setupAdminAuth()
  offlineFetch()
})

afterEach(async () => {
  // The codebuddy import branch schedules a long refresh timer; without this
  // the test process hangs on the live handle after the last test.
  cancelAllCodebuddyRefreshTimers()
  setTestAccounts(originalAccounts)
  globalThis.fetch = originalFetch
  redirectPathsToDir(isolationRoot)
  resetAdaptiveRateLimiterForTest()
  clearAdminAuth()
  clearAdminPasswordConfig()
})

afterAll(async () => {
  // Defer deletion until every background write has settled; removing a dir
  // mid-write on Windows can block the next test's mkdir.
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => undefined)
})

describe("standard account import (non-OAuth providers)", () => {
  test("imports copilot/codebuff/windsurf with their credential field", async () => {
    const { body } = await importAccounts([
      {
        label: "copilot-a",
        provider: "copilot",
        credentials: { githubToken: "gh-token" },
      },
      {
        label: "codebuff-a",
        provider: "codebuff",
        credentials: { authToken: "cb-token" },
      },
      {
        label: "windsurf-a",
        provider: "windsurf",
        credentials: { apiKey: "ws-key" },
      },
    ])

    expect(body.imported).toBe(3)
    expect(body.failed).toBe(0)

    const copilot = listAccounts().find((a) => a.label === "copilot-a")
    expect(copilot?.credentials?.githubToken).toBe("gh-token")
    const codebuff = listAccounts().find((a) => a.label === "codebuff-a")
    expect(codebuff?.credentials?.authToken).toBe("cb-token")
    const windsurf = listAccounts().find((a) => a.label === "windsurf-a")
    expect(windsurf?.credentials?.apiKey).toBe("ws-key")
  })

  test("mimo accepts credentials, top-level, or settings spellings", async () => {
    const { body } = await importAccounts([
      {
        label: "mimo-creds",
        provider: "mimo-aistudio",
        credentials: { serviceToken: "svc-1", xiaomichatbotPh: "ph-1" },
      },
      {
        label: "mimo-toplevel",
        provider: "mimo-aistudio",
        serviceToken: "svc-2",
        xiaomichatbotPh: "ph-2",
      },
      {
        label: "mimo-settings",
        provider: "mimo-aistudio",
        settings: { serviceToken: "svc-3", xiaomichatbotPh: "ph-3" },
      },
    ])

    expect(body.imported).toBe(3)
    expect(
      listAccounts().find((a) => a.label === "mimo-creds")?.credentials
        ?.serviceToken,
    ).toBe("svc-1")
    expect(
      listAccounts().find((a) => a.label === "mimo-toplevel")?.credentials
        ?.serviceToken,
    ).toBe("svc-2")
    expect(
      listAccounts().find((a) => a.label === "mimo-settings")?.credentials
        ?.serviceToken,
    ).toBe("svc-3")
  })

  test("mimo rejects a row missing either credential half", async () => {
    const { body } = await importAccounts([
      {
        label: "mimo-bad",
        provider: "mimo-aistudio",
        credentials: { serviceToken: "svc-only" },
      },
    ])
    expect(body.imported).toBe(0)
    expect(body.failed).toBe(1)
    expect(body.details.failed[0]?.reason).toContain("xiaomichatbotPh")
  })

  test("codebuddy and codebuddy-cn keep refreshToken/expiresAt", async () => {
    const { body } = await importAccounts([
      {
        label: "codebuddy-a",
        provider: "codebuddy",
        credentials: {
          accessToken: "cb-access",
          refreshToken: "cb-refresh",
          expiresAt: 1_800_000_000_000,
        },
      },
      {
        label: "codebuddy-cn-a",
        provider: "codebuddy-cn",
        credentials: { accessToken: "cn-access" },
      },
    ])

    expect(body.imported).toBe(2)
    const codebuddy = listAccounts().find((a) => a.label === "codebuddy-a")
    expect(codebuddy?.credentials?.accessToken).toBe("cb-access")
    expect(codebuddy?.credentials?.refreshToken).toBe("cb-refresh")
    expect(codebuddy?.credentials?.expiresAt).toBe(1_800_000_000_000)
    const cn = listAccounts().find((a) => a.label === "codebuddy-cn-a")
    expect(cn?.provider).toBe("codebuddy-cn")
    expect(cn?.credentials?.accessToken).toBe("cn-access")
  })

  test("lobsterai accepts accessToken alone and keeps optional fields", async () => {
    const { body } = await importAccounts([
      {
        label: "lobsterai-a",
        provider: "lobsterai",
        credentials: {
          refreshToken: "lb-refresh",
          uuid: "uuid-1",
          userId: "user-1",
          firstKeyfrom: "official",
        },
      },
    ])

    expect(body.imported).toBe(1)
    const lobster = listAccounts().find((a) => a.label === "lobsterai-a")
    expect(lobster?.credentials?.accessToken).toBe("")
    expect(lobster?.credentials?.refreshToken).toBe("lb-refresh")
    expect(lobster?.credentials?.uuid).toBe("uuid-1")
    expect(lobster?.credentials?.userId).toBe("user-1")
    expect(lobster?.credentials?.firstKeyfrom).toBe("official")
  })

  test("lobsterai rejects a row with neither token", async () => {
    const { body } = await importAccounts([
      {
        label: "lobsterai-bad",
        provider: "lobsterai",
        credentials: {},
      },
    ])
    expect(body.failed).toBe(1)
    expect(body.details.failed[0]?.reason).toContain("accessToken")
  })

  test("each missing-credential branch reports its own reason", async () => {
    const { body } = await importAccounts([
      { label: "cp-bad", provider: "copilot", credentials: {} },
      { label: "cb-bad", provider: "codebuff", credentials: {} },
      { label: "ws-bad", provider: "windsurf", credentials: {} },
      { label: "codebuddy-bad", provider: "codebuddy", credentials: {} },
    ])

    expect(body.imported).toBe(0)
    expect(body.failed).toBe(4)
    const reasons = new Map(body.details.failed.map((f) => [f.label, f.reason]))
    expect(reasons.get("cp-bad")).toContain("githubToken")
    expect(reasons.get("cb-bad")).toContain("authToken")
    expect(reasons.get("ws-bad")).toContain("apiKey")
    expect(reasons.get("codebuddy-bad")).toContain("accessToken")
  })

  test("re-importing the same label+provider is skipped unless overwrite", async () => {
    await importAccounts([
      {
        label: "dupe",
        provider: "codebuff",
        credentials: { authToken: "first" },
      },
    ])

    const skippedRun = await importAccounts([
      {
        label: "dupe",
        provider: "codebuff",
        credentials: { authToken: "second" },
      },
    ])
    expect(skippedRun.body.skipped).toBe(1)
    expect(
      listAccounts().find((a) => a.label === "dupe")?.credentials?.authToken,
    ).toBe("first")

    const overwriteRun = await adminJson(
      "http://localhost/admin/api/accounts/import",
      {
        method: "POST",
        body: JSON.stringify({
          overwrite: true,
          accounts: [
            {
              label: "dupe",
              provider: "codebuff",
              credentials: { authToken: "second" },
            },
          ],
        }),
      },
    )
    expect(overwriteRun.status).toBe(200)
    const dupe = listAccounts().filter((a) => a.label === "dupe")
    expect(dupe).toHaveLength(1)
    expect(dupe[0]?.credentials?.authToken).toBe("second")
  })

  test("an unrecognized provider id falls back to copilot", async () => {
    // `isProviderId(providerStr) ? providerStr : "copilot"` means an unknown
    // id is imported as copilot, not rejected — pre-existing contract.
    const { body } = await importAccounts([
      {
        label: "unknown-provider",
        provider: "definitely-not-a-provider",
        credentials: {},
      },
    ])

    expect(body.imported).toBe(0)
    expect(body.failed).toBe(1)
    expect(body.details.failed[0]?.reason).toContain("githubToken")
  })

  test("missing accounts array is rejected with 400", async () => {
    const response = await adminJson(
      "http://localhost/admin/api/accounts/import",
      { method: "POST", body: JSON.stringify({ accounts: [] }) },
    )
    expect(response.status).toBe(400)
  })
})

/** Guard against the extraction dropping the provider on the account shape. */
describe("import builder account shape", () => {
  test("imported accounts carry enabled/priority/settings defaults", async () => {
    await importAccounts([
      {
        label: "shape-check",
        provider: "codebuff",
        credentials: { authToken: "t" },
        settings: { baseUrl: "https://example.test" },
      },
    ])
    const account = listAccounts().find(
      (a): a is Account => a.label === "shape-check",
    )
    expect(account?.enabled).toBe(true)
    expect(account?.priority).toBe(0)
    expect(account?.quotaState).toBe("unknown")
    expect(account?.settings?.baseUrl).toBe("https://example.test")
  })
})
