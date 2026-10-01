/**
 * Admin plan-quota route tests.
 *
 * The routes only read and clear what the plan-quota store holds, so these
 * tests point the store at a temp file and seed it through the store's own
 * `keepReading`, exactly like a real reading would arrive.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Hono } from "hono"

import type { PlanAllowance } from "~/lib/plan-quota"

import {
  keepReading,
  resetPlanQuotaStore,
  setPlanQuotaFilePath,
} from "~/lib/plan-quota"
import { planQuotaApiRoutes } from "~/routes/admin/api/plan-quota"

const app = new Hono().route("/plan-quota", planQuotaApiRoutes)

const HOUR = 3_600_000
const FIVE_HOURS = 5 * HOUR

interface ReadingPayload {
  windows: PlanAllowance | null
  asOf: number | null
}

interface PersistedFile {
  version: number
  readings: Record<string, unknown>
}

let tempDir: string
let filePath: string

/** Windows that are still open at the real current time. */
function openWindows(now: number): PlanAllowance {
  return [
    { used: 0.4, spanMs: FIVE_HOURS, resetsAtMs: now + HOUR },
    { used: 0.1, spanMs: 7 * 24 * HOUR, resetsAtMs: now + 3 * 24 * HOUR },
  ]
}

async function readFile(): Promise<PersistedFile> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as PersistedFile
}

async function reset(body: unknown): Promise<Response> {
  return app.request("/plan-quota/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `plan-quota-route-${randomUUID()}-`),
  )
  filePath = path.join(tempDir, "plan-quota.json")
  setPlanQuotaFilePath(filePath)
})

afterEach(async () => {
  resetPlanQuotaStore()
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
})

describe("admin plan-quota route", () => {
  test("GET reports the last reading for a provider/user", async () => {
    const now = Date.now()
    const windows = openWindows(now)
    await keepReading("claude", "Alice@Example.com", windows, now)

    // The user segment is URL-encoded like any other path value.
    const response = await app.request("/plan-quota/claude/alice%40example.com")
    expect(response.status).toBe(200)
    const payload = (await response.json()) as ReadingPayload

    expect(payload.asOf).toBe(now)
    expect(payload.windows).toEqual(windows)
  })

  test("GET is empty for an account that was never read", async () => {
    const response = await app.request(
      "/plan-quota/claude/nobody%40example.com",
    )
    expect(response.status).toBe(200)
    expect((await response.json()) as ReadingPayload).toEqual({
      windows: null,
      asOf: null,
    })
  })

  test("reset clears one provider/user and keeps the rest", async () => {
    const now = Date.now()
    await keepReading("claude", "alice@example.com", openWindows(now), now)
    await keepReading("deepseek", "bob@example.com", openWindows(now), now)

    // The user matches case-insensitively, like the store's own key.
    const response = await reset({
      provider: "claude",
      user: "ALICE@example.com",
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    expect(Object.keys((await readFile()).readings)).toEqual([
      "deepseek/bob@example.com",
    ])

    // The cache was dropped, so the route re-reads the rewritten file.
    const cleared = await app.request("/plan-quota/claude/alice%40example.com")
    expect((await cleared.json()) as ReadingPayload).toEqual({
      windows: null,
      asOf: null,
    })

    const kept = await app.request("/plan-quota/deepseek/bob%40example.com")
    const keptPayload = (await kept.json()) as ReadingPayload
    expect(keptPayload.windows).toEqual(openWindows(now))
  })

  test("reset clears a whole provider", async () => {
    const now = Date.now()
    await keepReading("claude", "alice@example.com", openWindows(now), now)
    await keepReading("claude", "carol@example.com", openWindows(now), now)
    await keepReading("deepseek", "bob@example.com", openWindows(now), now)

    const response = await reset({ provider: "claude" })
    expect(await response.json()).toEqual({ ok: true })
    expect(Object.keys((await readFile()).readings)).toEqual([
      "deepseek/bob@example.com",
    ])
  })

  test("reset with no filter clears every reading", async () => {
    const now = Date.now()
    await keepReading("claude", "alice@example.com", openWindows(now), now)
    await keepReading("deepseek", "bob@example.com", openWindows(now), now)
    const version = (await readFile()).version

    const response = await reset({})
    expect(await response.json()).toEqual({ ok: true })

    const persisted = await readFile()
    expect(persisted.readings).toEqual({})
    expect(persisted.version).toBe(version)
  })

  test("reset tolerates a store that was never written", async () => {
    const response = await reset({ provider: "claude" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    // No reading file is created just to clear nothing.
    await expect(fs.access(filePath)).rejects.toThrow()
  })
})
