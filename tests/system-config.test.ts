import { afterEach, beforeEach, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { isDebugLoggingEnabled, logger, setRuntimeLogLevel } from "~/lib/logger"
import { isRequestDumpEnabled } from "~/lib/request-dump"
import {
  getRedactionDiagnostics,
  emptyRedactionDiagnostics,
  recordRedactionDiagnostics,
} from "~/lib/redaction/diagnostics"
import { RedactionScope } from "~/lib/redaction/context"
import { redactionConfigSchema } from "~/lib/redaction/rules"
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
  updateRedactionConfig,
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

test("account warmup defaults off, persists, preserves omitted updates and rejects invalid schedules", () => {
  expect(getSystemSettings().accountWarmup.enabled).toBe(false)
  const accountWarmup = {
    enabled: true,
    times: ["06:30", "11:30"],
    timeZone: "Asia/Shanghai",
    models: {
      claude: "claude-haiku-4-5",
      codex: "",
      antigravityGemini: "gemini-3.8-flash",
      antigravityClaude: "",
    },
  }
  updateSystemConfig({ ...normal, accountWarmup, logLevel: "debug" })
  const value = JSON.parse(saved!) as { expiresAt: number }
  value.expiresAt = Date.now() - 1
  initialize(JSON.stringify(value))
  updateSystemConfig(normal)
  expect(getSystemSettings().accountWarmup).toEqual(accountWarmup)
  for (const invalid of [
    { ...accountWarmup, times: [] },
    { ...accountWarmup, times: ["24:00"] },
    { ...accountWarmup, times: ["7:00"] },
    { ...accountWarmup, times: ["07:00", "07:00"] },
    { ...accountWarmup, timeZone: "invalid/zone" },
    { ...accountWarmup, enabled: "true" },
    { ...accountWarmup, models: { codex: 123 } },
    { ...accountWarmup, models: { unknown: "model" } },
  ])
    expect(() =>
      updateSystemConfig({ ...normal, accountWarmup: invalid }),
    ).toThrow()
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

test("redaction-only updates preserve unrelated settings and exact active dump expiry", async () => {
  updateSystemConfig({
    ...normal,
    logLevel: "debug",
    requestDump: true,
    memoryVerbose: true,
    acknowledgeSensitiveData: true,
    performanceDetails: false,
    concurrencyQueueLimit: 17,
    concurrencyQueueWaitSeconds: 42,
    codexAutoReset: true,
    zcodeAutoClaim: true,
    codexModelIds: ["custom-model"],
    quotaDisplayMode: "used",
    defaultProxyUrl: "http://proxy.example:8080",
    logRetentionDays: 3,
    logMaxTotalBytes: 123456,
    accountWarmup: {
      enabled: true,
      times: ["08:30"],
      timeZone: "UTC",
    },
  })
  const before = getSystemConfig()
  // A fixed timestamp makes even a same-millisecond expiry recalculation fail.
  const expiresAt = Date.now() + 543210
  initialize(JSON.stringify({ ...before, source: undefined, expiresAt }))
  const config = redactionConfigSchema.parse({
    enabled: true,
    words: ["latest.internal"],
    homePrefixes: ["/srv/private-person"],
  })
  const response = await systemConfigApiRoutes.request("/redaction-config", {
    method: "PUT",
    body: JSON.stringify(config),
  })
  expect(response.status).toBe(200)
  const expected = {
    ...before,
    settings: { ...before.settings, redaction: config },
    expiresAt,
  }
  expect(await response.json()).toEqual(expected)
  expect(getSystemConfig()).toEqual(expected)
  expect(JSON.parse(saved!)).toEqual({ settings: expected.settings, expiresAt })
  initialize(saved)
  expect(getSystemConfig()).toEqual(expected)
  expect(isRequestDumpEnabled()).toBe(true)
  updateSystemConfig(normal)
  expect(getSystemSettings().redaction).toEqual(config)
})

test("redaction-only updates preserve expired diagnostics without reactivating them", () => {
  updateSystemConfig({
    ...normal,
    logLevel: "debug",
    requestDump: true,
    memoryVerbose: true,
    acknowledgeSensitiveData: true,
  })
  const value = JSON.parse(saved!) as { expiresAt: number }
  value.expiresAt = Date.now() - 1000
  initialize(JSON.stringify(value))
  const before = getSystemConfig()
  const config = redactionConfigSchema.parse({ enabled: true })
  expect(updateRedactionConfig(config)).toEqual({
    ...before,
    settings: { ...before.settings, redaction: config },
  })
  expect(JSON.parse(saved!)).toEqual({
    settings: { ...before.settings, redaction: config },
    expiresAt: value.expiresAt,
  })
  expect(isRequestDumpEnabled()).toBe(false)
})

test("redaction-only updates reject invalid rules and bounded bodies without persistence", async () => {
  updateRedactionConfig({ enabled: true, words: ["saved.internal"] })
  const before = getSystemConfig()
  const persisted = saved
  for (const input of [
    { words: ["x"] },
    { words: ["private".repeat(200)] },
    { homePrefixes: [123] },
    { enabled: "true" },
    { private: "unknown-field" },
    { redaction: { enabled: true } },
  ]) {
    expect(() => updateRedactionConfig(input)).toThrow()
    const response = await systemConfigApiRoutes.request("/redaction-config", {
      method: "PUT",
      body: JSON.stringify(input),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "Invalid redaction configuration or rules.",
    })
  }
  for (const [body, status] of [
    ["{private-invalid", 400],
    ["x".repeat(1024 * 1024 + 1), 413],
  ] as const) {
    const response = await systemConfigApiRoutes.request("/redaction-config", {
      method: "PUT",
      body,
    })
    expect(response.status).toBe(status)
    expect(await response.text()).not.toContain("private")
  }
  expect(saved).toBe(persisted)
  expect(getSystemConfig()).toEqual(before)
  expect(
    (
      await server.request(
        "http://localhost/admin/api/system-config/redaction-config",
        { method: "PUT" },
      )
    ).status,
  ).toBe(403)
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

test("redaction preview uses isolated unsaved rules with safe counts and never changes settings or history", async () => {
  const config = redactionConfigSchema.parse({
    enabled: true,
    words: ["preview.internal"],
    homePrefixes: ["/srv/preview-person"],
  })
  const original = getSystemConfig()
  const history = getRedactionDiagnostics()
  const secret = "ExamplePreview" + "Pass123"
  const input = {
    password: "plain-private-value",
    text: `DB_PASSWORD=${secret} ${secret} /home/preview-person/work /srv/preview-person/work preview.internal preview.internal`,
  }
  const response = await systemConfigApiRoutes.request("/redaction-preview", {
    method: "POST",
    body: JSON.stringify({
      text: JSON.stringify(input),
      format: "json",
      config,
    }),
  })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const preview = (await response.json()) as {
    output: string
    enabled: boolean
    diagnostics: {
      total: number
      byKind: Record<string, number>
      bySource: Record<string, number>
      maskingMs: number
      restored: number
    }
  }
  expect(preview.enabled).toBe(true)
  for (const value of [
    secret,
    input.password,
    "preview-person",
    "preview.internal",
  ])
    expect(preview.output).not.toContain(value)
  expect(preview.diagnostics.total).toBe(5)
  expect(preview.diagnostics.byKind).toEqual({
    SECRET: 2,
    HOME: 2,
    WORD: 1,
    PERSONAL: 0,
  })
  expect(preview.diagnostics.bySource).toEqual({
    builtin: 2,
    field: 1,
    word: 1,
    homePrefix: 1,
    known: 0,
  })
  expect(preview.diagnostics.maskingMs).toBeGreaterThanOrEqual(0)
  expect(preview.diagnostics.restored).toBe(0)
  expect(getSystemConfig()).toEqual(original)
  expect(getRedactionDiagnostics()).toEqual(history)
  expect(saved).toBeUndefined()
  const independent = new RedactionScope(config)
  expect(independent.maskText(secret)).toBe(secret)
  expect(independent.restoreText(JSON.parse(preview.output).password)).toBe(
    JSON.parse(preview.output).password,
  )
  const disabled = await systemConfigApiRoutes.request("/redaction-preview", {
    method: "POST",
    body: JSON.stringify({
      text: JSON.stringify(input),
      format: "json",
      config: { ...config, enabled: false },
    }),
  })
  const unchanged = (await disabled.json()) as typeof preview
  expect(unchanged.output).toBe(JSON.stringify(input))
  expect(unchanged.enabled).toBe(false)
  expect(unchanged.diagnostics.total).toBe(0)
  expect(getRedactionDiagnostics()).toEqual(history)
})

test("redaction preview rejects invalid, deeply nested and oversized inputs without echoing content", async () => {
  for (const body of [
    "{private-invalid-body",
    JSON.stringify({
      text: "{private-invalid-json",
      format: "json",
      config: { enabled: true },
    }),
    JSON.stringify({
      text: "private",
      format: "html",
      config: { enabled: true },
    }),
    JSON.stringify({
      text: "private".repeat(10000),
      format: "text",
      config: { enabled: true },
    }),
    JSON.stringify({
      text: "private",
      format: "text",
      config: { words: ["private".repeat(200)] },
    }),
    JSON.stringify({
      text: "[".repeat(70) + '"private"' + "]".repeat(70),
      format: "json",
      config: { enabled: true },
    }),
  ]) {
    const response = await systemConfigApiRoutes.request("/redaction-preview", {
      method: "POST",
      body,
    })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain("private")
    expect(response.headers.get("cache-control")).toBe("no-store")
  }
  expect(
    (
      await systemConfigApiRoutes.request("/redaction-preview", {
        method: "POST",
        body: "x".repeat(1024 * 1024 + 1),
      })
    ).status,
  ).toBe(413)
  for (const [path, method] of [
    ["redaction-preview", "POST"],
    ["redaction-stats", "GET"],
    ["redaction-events", "GET"],
    ["redaction-inspection", "POST"],
    ["redaction-records", "DELETE"],
    ["redaction-records/1?reveal=1", "GET"],
  ]) {
    const response = await server.request(
      `http://localhost/admin/api/system-config/${path}`,
      { method },
    )
    expect(response.status).toBe(403)
  }
})

test("redaction live feed sends metadata invalidations and disconnects cleanly", async () => {
  const controller = new AbortController()
  const response = await systemConfigApiRoutes.request("/redaction-events", {
    signal: controller.signal,
  })
  expect(response.headers.get("content-type")).toContain("text/event-stream")
  expect(response.headers.get("cache-control")).toBe("no-cache")
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const readChange = async () => {
    let text = ""
    while (!text.includes("event: change")) {
      const item = await reader.read()
      if (item.done) throw new Error("unexpected feed EOF")
      text += decoder.decode(item.value)
    }
    expect(text).toContain("data: {}")
    expect(text).not.toContain("private-client")
  }
  try {
    await readChange()
    recordRedactionDiagnostics(emptyRedactionDiagnostics(), {
      client: "private-client",
      upstreams: [],
    })
    await readChange()
  } finally {
    controller.abort()
    await reader.cancel()
  }
})

test("inspection controls default to continuous, allow explicit temporary mode and stay independent of persisted settings", async () => {
  const before = getSystemConfig()
  const call = (body: string) =>
    systemConfigApiRoutes.request("/redaction-inspection", {
      method: "POST",
      body,
    })
  for (const body of [
    "{",
    '{"enabled":"true"}',
    '{"enabled":true,"unexpected":true}',
    "x".repeat(1025),
  ])
    expect((await call(body)).status).toBe(400)
  try {
    const continuous = await call('{"enabled":true}')
    expect(await continuous.json()).toMatchObject({
      mode: "continuous",
      expiresAt: null,
      retainsClientInput: false,
    })
    const enabled = await call('{"enabled":true,"mode":"temporary"}')
    expect(enabled.headers.get("cache-control")).toBe("no-store")
    const status = (await enabled.json()) as {
      enabled: boolean
      ttlMs: number
      expiresAt: number
      bytes: number
    }
    expect(status.enabled).toBe(true)
    expect(status.ttlMs).toBe(300_000)
    expect(status.expiresAt).toBeGreaterThan(Date.now())
    expect(status.bytes).toBe(0)
    const cleared = await systemConfigApiRoutes.request("/redaction-records", {
      method: "DELETE",
    })
    expect(await cleared.json()).toMatchObject({ enabled: true, bytes: 0 })
    const unavailable = await systemConfigApiRoutes.request(
      "/redaction-records/999999?reveal=1",
    )
    expect(unavailable.status).toBe(404)
    expect(unavailable.headers.get("cache-control")).toBe("no-store")
    expect(getSystemConfig()).toEqual(before)
    expect(saved).toBeUndefined()
  } finally {
    expect(await (await call('{"enabled":false}')).json()).toMatchObject({
      enabled: false,
      bytes: 0,
    })
  }
})
