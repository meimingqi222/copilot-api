import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { PlanAllowance } from "~/lib/plan-quota/types"

import {
  allowanceFor,
  allowanceFullAt,
  elapsed,
  isPassingError,
  keepReading,
  lastReading,
  mergeWithLast,
  planQuotaFilePath,
  resetPlanQuotaStore,
  setPlanQuotaFilePath,
  windowApplies,
} from "~/lib/plan-quota"

const HOUR = 3_600_000
const DAY = 86_400_000
const FIVE_HOURS = 5 * HOUR
const SEVEN_DAYS = 7 * DAY
const THIRTY_DAYS = 30 * DAY

const NOW = 1_700_000_000_000

describe("plan-quota windows", () => {
  test("elapsed empties a window whose reset instant has passed", () => {
    const windows: PlanAllowance = [
      { used: 0.8, spanMs: FIVE_HOURS, resetsAtMs: NOW - 1 },
      { used: 0.4, spanMs: SEVEN_DAYS, resetsAtMs: NOW + HOUR },
      { used: 0.2, spanMs: THIRTY_DAYS },
    ]

    expect(elapsed(windows, NOW)).toEqual([
      { used: 0, spanMs: FIVE_HOURS, resetsAtMs: undefined },
      { used: 0.4, spanMs: SEVEN_DAYS, resetsAtMs: NOW + HOUR },
      { used: 0.2, spanMs: THIRTY_DAYS },
    ])
  })

  test("elapsed keeps a window that resets exactly now", () => {
    const windows: PlanAllowance = [
      { used: 0.6, spanMs: FIVE_HOURS, resetsAtMs: NOW },
    ]

    expect(elapsed(windows, NOW)[0].used).toBe(0)
  })

  test("windowApplies scopes a model window to models that contain the word", () => {
    const opus = { used: 0.5, model: "opus" }

    expect(windowApplies(opus, "claude-sonnet-4-5")).toBe(false)
    expect(windowApplies(opus, "claude-opus-4-1")).toBe(true)
    expect(windowApplies(opus, "OPUS-4")).toBe(true)
    expect(windowApplies(opus, "Claude-Opus-4-1")).toBe(true)
  })

  test("windowApplies treats an unscoped window as every model", () => {
    expect(windowApplies({ used: 0.5 }, "claude-sonnet-4-5")).toBe(true)
    expect(windowApplies({ used: 0.5, model: "  " }, "any-model")).toBe(true)
  })

  test("windowApplies answers for every window when no model is given", () => {
    expect(windowApplies({ used: 0.5, model: "opus" })).toBe(true)
    expect(windowApplies({ used: 0.5, model: "opus" }, "")).toBe(true)
  })

  test("allowanceFor reports the fullest applying share and per-model renewals", () => {
    const windows: PlanAllowance = [
      { used: 0.2, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR },
      { used: 0.9, spanMs: SEVEN_DAYS, resetsAtMs: NOW + 3 * DAY },
      {
        used: 0.95,
        spanMs: SEVEN_DAYS,
        resetsAtMs: NOW + 5 * DAY,
        model: "opus",
      },
      { used: 0.35, spanMs: THIRTY_DAYS, resetsAtMs: NOW + 20 * DAY },
    ]

    // Biggest window first, then the later reset within the same span.
    expect(allowanceFor(windows, undefined, NOW).renews).toEqual([
      NOW + 20 * DAY,
      NOW + 5 * DAY,
      NOW + 3 * DAY,
      NOW + HOUR,
    ])

    // A sonnet model never sees the "opus" window.
    const sonnet = allowanceFor(windows, "claude-sonnet-4-5", NOW)
    expect(sonnet.used).toBe(0.9)
    expect(sonnet.renews).toEqual([NOW + 20 * DAY, NOW + 3 * DAY, NOW + HOUR])

    // The fuller opus window does count an opus model.
    const opus = allowanceFor(windows, "claude-opus-4-1", NOW)
    expect(opus.used).toBe(0.95)
    expect(opus.renews).toEqual([
      NOW + 20 * DAY,
      NOW + 5 * DAY,
      NOW + 3 * DAY,
      NOW + HOUR,
    ])
  })

  test("allowanceFor advances windows before reporting", () => {
    const windows: PlanAllowance = [
      { used: 1, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR },
      { used: 0.4, spanMs: SEVEN_DAYS, resetsAtMs: NOW + DAY },
    ]

    const advanced = allowanceFor(windows, undefined, NOW + 2 * HOUR)
    expect(advanced.used).toBe(0.4)
    expect(advanced.renews).toEqual([NOW + DAY])
  })

  test("allowanceFullAt returns the latest reset among saturated windows", () => {
    const windows: PlanAllowance = [
      { used: 0.2, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR },
      { used: 0.9, spanMs: SEVEN_DAYS, resetsAtMs: NOW + 3 * DAY },
      { used: 0.85, spanMs: THIRTY_DAYS, resetsAtMs: NOW + 20 * DAY },
    ]

    expect(allowanceFullAt(windows, "claude-sonnet-4-5", 0.8, NOW)).toBe(
      NOW + 20 * DAY,
    )
    expect(
      allowanceFullAt(windows, "claude-sonnet-4-5", 0.95, NOW),
    ).toBeUndefined()
  })

  test("allowanceFullAt ignores non-applying and reset-less windows", () => {
    const windows: PlanAllowance = [
      { used: 1, spanMs: SEVEN_DAYS, model: "opus" },
      { used: 1, spanMs: THIRTY_DAYS },
    ]

    expect(
      allowanceFullAt(windows, "claude-sonnet-4-5", 0.5, NOW),
    ).toBeUndefined()
    expect(
      allowanceFullAt(windows, "claude-opus-4-1", 0.5, NOW),
    ).toBeUndefined()
  })
})

describe("plan-quota store", () => {
  let tempDir: string
  let filePath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `plan-quota-${randomUUID()}-`),
    )
    filePath = path.join(tempDir, "plan-quota.json")
    setPlanQuotaFilePath(filePath)
  })

  afterEach(async () => {
    resetPlanQuotaStore()
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  test("keepReading/lastReading round-trip through the file", async () => {
    const windows: PlanAllowance = [
      { used: 0.4, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR },
      {
        used: 0.1,
        spanMs: SEVEN_DAYS,
        resetsAtMs: NOW + 3 * DAY,
        model: "opus",
      },
    ]

    await keepReading("claude", "Alice@Example.com", windows, NOW)
    expect(planQuotaFilePath()).toBe(filePath)

    // A lower-cased user resolves to the same reading.
    const restored = await lastReading(
      "claude",
      "alice@example.com",
      NOW + 1000,
    )
    expect(restored?.asOf).toBe(NOW)
    expect(restored?.windows).toEqual(windows)

    // Survives a cache drop, i.e. a fresh process reading the same file.
    setPlanQuotaFilePath(filePath)
    const reloaded = await lastReading(
      "claude",
      "ALICE@example.com",
      NOW + 1000,
    )
    expect(reloaded?.windows).toEqual(windows)

    const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      version: number
      readings: Record<string, unknown>
    }
    expect(persisted.version).toBe(1)
    expect(Object.keys(persisted.readings)).toEqual([
      "claude/alice@example.com",
    ])
  })

  test("lastReading advances a window that reset since the reading", async () => {
    await keepReading(
      "claude",
      "alice",
      [{ used: 0.9, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR }],
      NOW,
    )

    const restored = await lastReading("claude", "alice", NOW + 2 * HOUR)
    expect(restored?.windows).toEqual([
      { used: 0, spanMs: FIVE_HOURS, resetsAtMs: undefined },
    ])
    expect(restored?.asOf).toBe(NOW)
  })

  test("lastReading returns undefined for an unknown account", async () => {
    expect(await lastReading("claude", "nobody", NOW)).toBeUndefined()
  })

  test("mergeWithLast stores and returns a good reading unstale", async () => {
    const windows: PlanAllowance = [
      { used: 0.5, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR },
    ]

    const merged = await mergeWithLast(
      { provider: "claude", user: "alice", windows },
      NOW,
    )

    expect(merged).toEqual({ windows, asOf: NOW, stale: false })
    expect((await lastReading("claude", "alice", NOW))?.windows).toEqual(
      windows,
    )
  })

  test("mergeWithLast replays the last reading on a passing error", async () => {
    await keepReading(
      "claude",
      "alice",
      [{ used: 0.7, spanMs: SEVEN_DAYS, resetsAtMs: NOW + 3 * DAY }],
      NOW,
    )

    const merged = await mergeWithLast(
      { provider: "claude", user: "alice", error: "fetch failed: ECONNRESET" },
      NOW + HOUR,
    )

    expect(merged.stale).toBe(true)
    expect(merged.asOf).toBe(NOW)
    expect(merged.windows).toEqual([
      { used: 0.7, spanMs: SEVEN_DAYS, resetsAtMs: NOW + 3 * DAY },
    ])
  })

  test("mergeWithLast replays an advanced reading when the window has moved on", async () => {
    await keepReading(
      "claude",
      "alice",
      [{ used: 1, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR }],
      NOW,
    )

    const merged = await mergeWithLast(
      { provider: "claude", user: "alice", error: "upstream returned 503" },
      NOW + 3 * HOUR,
    )

    expect(merged.stale).toBe(true)
    expect(merged.windows).toEqual([
      { used: 0, spanMs: FIVE_HOURS, resetsAtMs: undefined },
    ])
  })

  test("mergeWithLast has nothing to replay before the first reading", async () => {
    const merged = await mergeWithLast(
      { provider: "claude", user: "alice", error: "not read yet" },
      NOW,
    )

    expect(merged).toEqual({ windows: [], stale: true })
  })

  test("mergeWithLast keeps the stored reading on a terminal error", async () => {
    const stored: PlanAllowance = [
      { used: 0.3, spanMs: FIVE_HOURS, resetsAtMs: NOW + HOUR },
    ]
    await keepReading("claude", "alice", stored, NOW)

    const merged = await mergeWithLast(
      { provider: "claude", user: "alice", error: "sign-in expired" },
      NOW + HOUR,
    )

    expect(merged).toEqual({ windows: [], stale: false })
    expect((await lastReading("claude", "alice", NOW))?.windows).toEqual(stored)
  })

  test("an unreadable file is treated as an empty store", async () => {
    await fs.writeFile(filePath, "{ not json", "utf8")

    expect(await lastReading("claude", "alice", NOW)).toBeUndefined()

    await keepReading("claude", "alice", [{ used: 0.5 }], NOW)
    expect((await lastReading("claude", "alice", NOW))?.windows).toEqual([
      { used: 0.5 },
    ])
  })
})

describe("isPassingError", () => {
  const passing = [
    "Quota not read yet",
    "rate limit exceeded",
    "429 Too Many Requests",
    "upstream returned 503 Service Unavailable",
    "502 Bad Gateway",
    "504 Gateway Timeout",
    "internal server error",
    "request timed out after 30s",
    "connect ETIMEDOUT 203.0.113.1:443",
    "connect ECONNREFUSED 127.0.0.1:9",
    "read ECONNRESET",
    "connection reset by peer",
    "getaddrinfo ENOTFOUND api.example.com",
    "getaddrinfo EAI_AGAIN",
    "no such host",
    "unexpected EOF",
    "fetch failed",
    "socket hang up",
  ]

  const terminal = [
    "sign-in expired",
    "refresh token revoked",
    "invalid_grant",
    "Unauthorized",
    "this account has no plan",
    "missing credential",
  ]

  test.each(passing)("treats %p as transient", (message) => {
    expect(isPassingError(message)).toBe(true)
  })

  test.each(terminal)("treats %p as terminal", (message) => {
    expect(isPassingError(message)).toBe(false)
  })
})
