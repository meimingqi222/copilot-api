import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { isDebugLoggingEnabled, logger, setRuntimeLogLevel } from "~/lib/logger"
import { isRequestDumpEnabled } from "~/lib/request-dump"
import {
  enforceLogStorageLimits,
  readLogRotationConfig,
  RotatingLogFileSink,
} from "~/lib/log-rotation"
import {
  requestPerformanceSnapshot,
  startRequestPerformance,
} from "~/lib/request-performance"
import {
  getSystemConfig,
  getSystemSettings,
  initializeSystemConfig,
  updateSystemConfig,
} from "~/lib/system-config"
import { server } from "~/server"
import { systemConfigApiRoutes } from "~/routes/admin/api/system-config"

let saved: string | undefined
let applied: string | undefined
const normal = {
  logLevel: "info",
  requestDump: false,
  memoryVerbose: false,
  performanceDetails: true,
  debugMinutes: 15,
} as const
const originalLevel = logger.level

function initialize(value?: string): void {
  initializeSystemConfig({
    value,
    save: (data) => {
      saved = data
    },
    onChange: (settings) => {
      applied = settings.logLevel
    },
  })
}

beforeEach(() => {
  saved = undefined
  applied = undefined
  initialize()
})

afterEach(() => {
  initialize()
  setRuntimeLogLevel("info")
  logger.level = originalLevel
})

test("saved settings override environment and survive reinitialization", () => {
  updateSystemConfig({ ...normal, performanceDetails: false })
  expect(saved).toBeDefined()
  initialize(saved)
  expect(getSystemConfig().source).toBe("webui")
  expect(getSystemSettings().performanceDetails).toBe(false)
  expect(getSystemConfig().expiresAt).toBeNull()
})

test("Codex picker selection persists, survives expiry and omitted updates, and validates the 100 model limit", () => {
  expect(getSystemSettings().codexModelIds).toBeNull()
  updateSystemConfig({
    ...normal,
    codexModelIds: ["second", "first"],
    logLevel: "debug",
  })
  const value = JSON.parse(saved!) as { expiresAt: number }
  value.expiresAt = Date.now() - 1
  initialize(JSON.stringify(value))
  expect(getSystemSettings().codexModelIds).toEqual(["second", "first"])
  updateSystemConfig(normal)
  expect(getSystemSettings().codexModelIds).toEqual(["second", "first"])
  updateSystemConfig({
    ...normal,
    codexModelIds: Array.from({ length: 100 }, (_, i) => `model-${i}`),
  })
  for (const ids of [
    ["duplicate", "duplicate"],
    [""],
    [1],
    "model",
    Array.from({ length: 101 }, (_, i) => `model-${i}`),
  ]) {
    expect(() =>
      updateSystemConfig({ ...normal, codexModelIds: ids }),
    ).toThrow()
  }
  expect(getSystemSettings().codexModelIds).toHaveLength(100)
  updateSystemConfig({ ...normal, codexModelIds: [] })
  initialize(saved)
  expect(getSystemSettings().codexModelIds).toEqual([])
  updateSystemConfig({ ...normal, codexModelIds: null })
  expect(getSystemSettings().codexModelIds).toBeNull()
})

test("log storage limits persist and survive diagnostic expiry", () => {
  updateSystemConfig({
    ...normal,
    logRetentionDays: 3,
    logMaxTotalBytes: 64 * 1024 * 1024,
    logLevel: "debug",
  })
  const stored = JSON.parse(saved!) as { settings: unknown; expiresAt: number }
  stored.expiresAt = Date.now() - 1
  initialize(JSON.stringify(stored))
  expect(readLogRotationConfig().retentionDays).toBe(3)
  expect(readLogRotationConfig().maxTotalBytes).toBe(64 * 1024 * 1024)
  updateSystemConfig(normal)
  expect(readLogRotationConfig().maxTotalBytes).toBe(64 * 1024 * 1024)
  expect(readLogRotationConfig().retentionDays).toBe(3)
  for (const value of [0, -1, 1.5, "7"]) {
    expect(() =>
      updateSystemConfig({ ...normal, logRetentionDays: value }),
    ).toThrow()
    expect(() =>
      updateSystemConfig({ ...normal, logMaxTotalBytes: value }),
    ).toThrow()
  }
})

test("saving log limits immediately prunes and updates an existing writer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-config-"))
  const originalDir = process.env.LOG_DIR
  process.env.LOG_DIR = dir
  try {
    initializeSystemConfig({
      save: (value) => {
        saved = value
      },
      onChange: () => enforceLogStorageLimits(),
    })
    const sink = new RotatingLogFileSink()
    sink.append("x".repeat(20))
    const app = new Hono().route("/", systemConfigApiRoutes)
    const response = await app.request("/", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...normal,
        logRetentionDays: 2,
        logMaxTotalBytes: 6,
      }),
    })
    expect(response.status).toBe(200)
    expect(fs.readdirSync(dir)).toHaveLength(0)
    sink.append("x".repeat(20))
    expect(fs.readdirSync(dir)).toHaveLength(0)
    sink.append("ok")
    expect(fs.readFileSync(sink.getActivePath(), "utf8")).toBe("ok")
    initialize(saved)
    expect(readLogRotationConfig().maxTotalBytes).toBe(6)
  } finally {
    if (originalDir === undefined) delete process.env.LOG_DIR
    else process.env.LOG_DIR = originalDir
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("quota display mode persists and legacy configs default to remaining", () => {
  expect(getSystemSettings().quotaDisplayMode).toBe("remaining")
  updateSystemConfig({ ...normal, quotaDisplayMode: "used" })
  initialize(saved)
  expect(getSystemSettings().quotaDisplayMode).toBe("used")
  expect(() =>
    updateSystemConfig({ ...normal, quotaDisplayMode: "invalid" }),
  ).toThrow()
  const { debugMinutes: _minutes, ...legacySettings } = normal
  initialize(JSON.stringify({ settings: legacySettings, expiresAt: null }))
  expect(getSystemSettings().quotaDisplayMode).toBe("remaining")
})

test("Codex auto reset defaults off, persists and survives diagnostic expiry", () => {
  expect(getSystemSettings().codexAutoReset).toBe(false)
  updateSystemConfig({ ...normal, codexAutoReset: true, logLevel: "debug" })
  const stored = JSON.parse(saved!) as { settings: unknown; expiresAt: number }
  stored.expiresAt = Date.now() - 1
  initialize(JSON.stringify(stored))
  expect(getSystemSettings().codexAutoReset).toBe(true)
  expect(getSystemSettings().logLevel).toBe("info")
  expect(() =>
    updateSystemConfig({ ...normal, codexAutoReset: "true" }),
  ).toThrow()
  updateSystemConfig({ ...normal, codexAutoReset: false })
  initialize(saved)
  expect(getSystemSettings().codexAutoReset).toBe(false)
})

test("dump needs explicit acknowledgement and expires with verbose logs", () => {
  expect(() => updateSystemConfig({ ...normal, requestDump: true })).toThrow()
  updateSystemConfig({
    ...normal,
    logLevel: "debug",
    requestDump: true,
    memoryVerbose: true,
    acknowledgeSensitiveData: true,
  })
  expect(isRequestDumpEnabled()).toBe(true)
  const stored = JSON.parse(saved!) as {
    settings: typeof normal
    expiresAt: number
  }
  stored.expiresAt = Date.now() - 1
  initialize(JSON.stringify(stored))
  expect(isRequestDumpEnabled()).toBe(false)
  expect(getSystemSettings().memoryVerbose).toBe(false)
  expect(getSystemSettings().logLevel).toBe("info")
  expect(applied).toBe("info")
})

test("timer applies expiration without requiring a new request", async () => {
  const { debugMinutes: _minutes, ...settings } = normal
  initialize(
    JSON.stringify({
      settings: { ...settings, logLevel: "debug" },
      expiresAt: Date.now() + 30,
    }),
  )
  expect(applied).toBe("debug")
  await Bun.sleep(80)
  expect(applied).toBe("info")
})

test("invalid values, coercion and unknown options do not mutate settings", () => {
  for (const input of [
    { ...normal, debugMinutes: 0 },
    { ...normal, debugMinutes: 121 },
    { ...normal, debugMinutes: 1.5 },
    { ...normal, performanceDetails: "false" },
    { ...normal, logLevel: "off" },
    { ...normal, logDir: "/tmp" },
  ]) {
    expect(() => updateSystemConfig(input)).toThrow()
  }
  expect(saved).toBeUndefined()
})

test("failed persistence does not apply new settings", () => {
  initializeSystemConfig({
    save: () => {
      throw new Error("disk full")
    },
    onChange: () => {},
  })
  expect(() =>
    updateSystemConfig({ ...normal, performanceDetails: false }),
  ).toThrow("disk full")
  expect(getSystemSettings().performanceDetails).toBe(true)
})

test("runtime logger level enables and disables expensive debug guards", () => {
  setRuntimeLogLevel("debug")
  expect(isDebugLoggingEnabled()).toBe(true)
  setRuntimeLogLevel("warn")
  expect(isDebugLoggingEnabled()).toBe(false)
  expect(logger.level).toBe(1)
})

test("performance collection is decided at request start", async () => {
  const app = new Hono()
  app.get("/", (c) => {
    startRequestPerformance(c, 10)
    updateSystemConfig({ ...normal, performanceDetails: false })
    expect(requestPerformanceSnapshot(c, true, 20)).toBeDefined()
    startRequestPerformance(c, 30)
    expect(requestPerformanceSnapshot(c, true, 40)).toBeUndefined()
    return c.text("OK")
  })
  expect((await app.request("/")).status).toBe(200)
})

test("API rejects malformed bodies and validates settings", async () => {
  const app = new Hono().route("/", systemConfigApiRoutes)
  expect((await app.request("/", { method: "PUT", body: "{" })).status).toBe(
    400,
  )
  expect(
    (
      await app.request("/", {
        method: "PUT",
        body: JSON.stringify({ ...normal, requestDump: true }),
      })
    ).status,
  ).toBe(400)
  const response = await app.request("/", {
    method: "PUT",
    body: JSON.stringify(normal),
  })
  expect(response.status).toBe(200)
  expect(((await response.json()) as { source: string }).source).toBe("webui")
})

test("production admin mount forbids unauthenticated reads and writes", async () => {
  for (const method of ["GET", "PUT"]) {
    const response = await server.request(
      "http://localhost/admin/api/system-config",
      { method },
    )
    expect(response.status).toBe(403)
  }
  expect(
    (
      await server.request(
        "http://localhost/admin/api/system-config/codex-models",
      )
    ).status,
  ).toBe(403)
})
