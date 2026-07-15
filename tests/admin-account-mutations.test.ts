/**
 * Regression tests for admin account mutation endpoints (PUT /:id, POST /:id/activate).
 *
 * These cover the case where label/priority/enabled-only mutations (no settings,
 * no credentialValue) must be persisted to the underlying connection. Previously
 * `syncAndSave(accountId)` re-fetched a fresh un-mutated snapshot via getAccount(id),
 * silently dropping the caller's mutations.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { Account } from "~/lib/accounts"

import { listAccounts } from "~/lib/accounts"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
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
const testDir = path.join(process.cwd(), ".tmp-admin-account-mutations")

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

function copilotAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: overrides.id ?? "cp-test-1",
    label: overrides.label ?? "copilot-test",
    provider: "copilot",
    credentials: {
      githubToken: overrides.credentials?.githubToken ?? "gh-test",
    },
    settings: overrides.settings ?? {},
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 0,
    quotaState: overrides.quotaState ?? "unknown",
    createdAt: overrides.createdAt ?? Date.now(),
  }
}

beforeEach(async () => {
  await fs.mkdir(testDir, { recursive: true })
  redirectPathsToDir(testDir)
  initializeProviderRegistry()
  statsStore.clearUsageStatsForTest()
  setTestAccounts([])
  state.users = []
  state.legacyApiKey = undefined
  state.adminPassword = undefined
  clearAdminPasswordConfig()
  setupAdminAuth()
  // Stub fetch so any background model/quota refresh doesn't hit network.
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("{}", { status: 404 }),
    )) as unknown as typeof fetch
})

afterEach(async () => {
  setTestAccounts(originalAccounts)
  globalThis.fetch = originalFetch
  redirectPathsToDir(isolationRoot)
  resetAdaptiveRateLimiterForTest()
  clearAdminAuth()
  clearAdminPasswordConfig()
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => undefined)
})

describe("admin account mutation persistence", () => {
  test("PUT /admin/api/accounts/:id persists label-only change", async () => {
    setTestAccounts([
      copilotAccount({ id: "cp-label", label: "original-label" }),
    ])

    const response = await adminJson(
      "http://localhost/admin/api/accounts/cp-label",
      {
        method: "PUT",
        body: JSON.stringify({ label: "renamed-label" }),
      },
    )
    expect(response.status).toBe(200)

    // Re-read from the connection (the truth source) — label must persist.
    const after = listAccounts().find((a) => a.id === "cp-label")
    expect(after?.label).toBe("renamed-label")
  })

  test("PUT /admin/api/accounts/:id persists priority-only change", async () => {
    setTestAccounts([copilotAccount({ id: "cp-prio", priority: 0 })])

    const response = await adminJson(
      "http://localhost/admin/api/accounts/cp-prio",
      {
        method: "PUT",
        body: JSON.stringify({ priority: 42 }),
      },
    )
    expect(response.status).toBe(200)

    const after = listAccounts().find((a) => a.id === "cp-prio")
    expect(after?.priority).toBe(42)
  })

  test("PUT /admin/api/accounts/:id persists enabled-only change", async () => {
    setTestAccounts([copilotAccount({ id: "cp-toggle", enabled: true })])

    const response = await adminJson(
      "http://localhost/admin/api/accounts/cp-toggle",
      {
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      },
    )
    expect(response.status).toBe(200)

    const after = listAccounts().find((a) => a.id === "cp-toggle")
    expect(after?.enabled).toBe(false)
  })

  test("POST /admin/api/accounts/:id/activate persists priority change", async () => {
    // Seed two accounts so activate has a meaningful min-priority baseline.
    setTestAccounts([
      copilotAccount({ id: "cp-a", label: "copilot-a", priority: 10 }),
      copilotAccount({ id: "cp-b", label: "copilot-b", priority: 5 }),
    ])

    const response = await adminJson(
      "http://localhost/admin/api/accounts/cp-b/activate",
      { method: "POST" },
    )
    expect(response.status).toBe(200)

    // After activate, cp-b should have priority < 5 (the previous min).
    const after = listAccounts().find((a) => a.id === "cp-b")
    expect(after?.priority).toBeLessThan(5)
    expect(after?.priority).toBeGreaterThanOrEqual(0)
  })
})
