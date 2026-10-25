import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { gunzipSync } from "node:zlib"

import { Hono } from "hono"
import os from "node:os"

import { buildDiagnosticBundle } from "~/lib/diagnostics/bundle"
import { requestLogger } from "~/lib/log-middleware"
import { logStore } from "~/lib/log-store"
import {
  configureLoggerForTest,
  logger,
  resetLoggerForTest,
} from "~/lib/logger"
import { handleSseStream, writeSseEvent } from "~/lib/sse"
import { recentSystemLogs } from "~/lib/system-log-bus"
import { dateKeyFromDate } from "~/lib/log-rotation"
import { PATHS } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import type { SystemLogEntry } from "~/lib/system-log-bus"
import { matchesSystemLog, querySystemLogs } from "~/lib/system-log-query"
import { diagnosticsApiRoutes } from "~/routes/admin/api/diagnostics"
import { systemLogApiRoutes } from "~/routes/admin/api/system-logs"

import { testConnection } from "./claude-cli-fixtures"

const NOW = Date.now()
const today = dateKeyFromDate(new Date(NOW))
const KEY = "sk-bundletest1234567890abcd"

function entry(partial: Partial<SystemLogEntry>): SystemLogEntry {
  return {
    id: 1,
    ts: NOW,
    level: "info",
    sub: "app",
    msg: "line",
    ...partial,
  }
}

function writeLines(name: string, lines: Array<string>): void {
  fs.mkdirSync(PATHS.LOG_DIR, { recursive: true })
  fs.writeFileSync(path.join(PATHS.LOG_DIR, name), lines.join("\n") + "\n")
}

test("connection links recover untagged historical metadata and quoted names without crossing connections", () => {
  const query = { conn: "conn-old", connName: "Old account" }
  expect(
    matchesSystemLog(entry({ ctx: { connectionId: "conn-old" } }), query),
  ).toBe(true)
  expect(
    matchesSystemLog(entry({ msg: 'Connection "Old account" failed' }), query),
  ).toBe(true)
  expect(
    matchesSystemLog(
      entry({ conn: "other", msg: 'Connection "Old account" failed' }),
      query,
    ),
  ).toBe(false)
  expect(
    matchesSystemLog(
      entry({ msg: 'Connection "Old account backup" failed' }),
      query,
    ),
  ).toBe(false)
})

beforeEach(() => {
  fs.rmSync(PATHS.LOG_DIR, { recursive: true, force: true })
  writeLines(`system-${today}.jsonl`, [
    JSON.stringify(entry({ id: 1, ts: NOW - 3000, msg: "boot" })),
    JSON.stringify(
      entry({
        id: 2,
        ts: NOW - 2000,
        level: "warn",
        sub: "quota",
        msg: "quota refresh failed",
        job: "quota-refresh",
        run: "r1",
      }),
    ),
    JSON.stringify(
      entry({
        id: 3,
        ts: NOW - 1000,
        level: "error",
        sub: "dispatch",
        msg: "upstream reset",
        req: "req-42",
        conn: "conn-claude",
        err: { name: "Error", message: "upstream reset", stack: "Error: x" },
      }),
    ),
    '{"id":4,"ts":', // cut short by a crash
  ])
  // An earlier version's text log, written before value-level redaction.
  writeLines(`server-${today}.log`, [
    `${new Date(NOW - 5000).toISOString()} [WARN] [auth] refresh failed for https://x.test/t?token=${KEY} {"requestId":"req-old"}`,
  ])
})

afterEach(() => {
  fs.rmSync(PATHS.LOG_DIR, { recursive: true, force: true })
  __resetProviderConnectionsForTest()
})

test("reads newest first across the JSONL and the legacy text log, skipping a torn line", () => {
  const { entries, more } = querySystemLogs({})
  expect(entries.map((item) => item.msg)).toEqual([
    "upstream reset",
    "quota refresh failed",
    "boot",
    `refresh failed for https://x.test/t?token=[redacted]`,
  ])
  expect(more).toBe(false)
  expect(entries[3]).toMatchObject({
    level: "warn",
    sub: "auth",
    req: "req-old",
  })
})

test("filters by level, subsystem, request, job and text, and pages with before", () => {
  const msgs = (query: Parameters<typeof querySystemLogs>[0]) =>
    querySystemLogs(query).entries.map((item) => item.msg)
  expect(msgs({ level: "warn" })).toHaveLength(3)
  expect(msgs({ subs: ["quota"] })).toEqual(["quota refresh failed"])
  expect(msgs({ req: "req-42" })).toEqual(["upstream reset"])
  expect(msgs({ job: "quota-refresh", run: "r1" })).toEqual([
    "quota refresh failed",
  ])
  expect(msgs({ q: "BOOT" })).toEqual(["boot"])
  const first = querySystemLogs({ limit: 2 })
  expect(first.more).toBe(true)
  const next = querySystemLogs({ limit: 2, before: first.entries[1].ts })
  expect(next.entries.map((item) => item.msg)[0]).toBe("boot")
})

test("the API answers queries and exports JSONL oldest first", async () => {
  const listed = (await (
    await systemLogApiRoutes.request("/?level=error&req=req-42")
  ).json()) as { entries: Array<SystemLogEntry> }
  expect(listed.entries.map((item) => item.msg)).toEqual(["upstream reset"])
  const exported = await systemLogApiRoutes.request(
    "/export?sub=quota,dispatch",
  )
  expect(exported.headers.get("content-disposition")).toContain(".jsonl")
  const lines = (await exported.text()).trim().split("\n")
  expect(lines.map((line) => (JSON.parse(line) as SystemLogEntry).msg)).toEqual(
    ["quota refresh failed", "upstream reset"],
  )
  writeLines(`server-${today}.log`, [
    `${new Date(NOW).toISOString()} [WARN] [auth] Connection "Old account" refresh failed`,
  ])
  const historical = await systemLogApiRoutes.request(
    "/?conn=conn-old&connName=Old%20account",
  )
  const recovered = (await historical.json()) as {
    entries: Array<SystemLogEntry>
  }
  expect(recovered.entries.map((item) => item.msg)).toEqual([
    'Connection "Old account" refresh failed',
  ])
})

test("the bundle holds what helps and none of the planted secrets", async () => {
  const connection = testConnection()
  connection.credentials[0].value = "sk-credentialvalue1234567890"
  connection.credentials[0].lastError = `401 Bearer ${KEY.slice(3)}xyz`
  connection.baseUrl = "https://user:hunter22@relay.test/v1?key=SECRETQ"
  upsertProviderConnection(connection)
  writeLines(`requests-${today}.jsonl`, [
    JSON.stringify({
      id: 1,
      timestamp: NOW - 500,
      level: "error",
      message: "POST /v1/messages 502",
      statusCode: 502,
      errorSnippet: `upstream said key ${KEY} is invalid`,
    }),
    JSON.stringify({
      id: 2,
      timestamp: NOW - 400,
      level: "info",
      message: "POST /v1/messages 200",
      statusCode: 200,
    }),
  ])

  const bundle = await buildDiagnosticBundle({ sinceMs: 3_600_000, now: NOW })
  const text = JSON.stringify(bundle)
  for (const secret of [
    KEY,
    KEY.slice(3),
    "sk-credentialvalue1234567890",
    "hunter22",
    "SECRETQ",
  ])
    expect(text).not.toContain(secret)
  expect(bundle.manifest.counts).toMatchObject({
    systemLogs: 4,
    requests: 1, // failed only by default
    connections: 1,
  })
  expect(bundle.manifest.redactions).toBeGreaterThan(0)
  expect(text).toContain("upstream reset")
  expect(text).toContain("relay.test")
  expect(text).toContain("conn-claude")

  const preview = (await (
    await diagnosticsApiRoutes.request("/bundle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sinceHours: 1, preview: true }),
    })
  ).json()) as { manifest: { counts: Record<string, number> }; bytes: number }
  expect(preview.manifest.counts.requests).toBe(1)
  expect(preview.bytes).toBeGreaterThan(0)

  const download = await diagnosticsApiRoutes.request("/bundle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sinceHours: 1, requests: "all" }),
  })
  expect(download.headers.get("content-disposition")).toContain(".json.gz")
  const unpacked = JSON.parse(
    gunzipSync(new Uint8Array(await download.arrayBuffer())).toString("utf8"),
  ) as { manifest: { counts: Record<string, number> } }
  expect(unpacked.manifest.counts.requests).toBe(2)
})

test("lines written while serving a request, and its stream, carry its request id", async () => {
  configureLoggerForTest({
    logFilePath: path.join(os.tmpdir(), `correlation-${process.pid}.jsonl`),
    resetReporter: true,
  })
  try {
    const app = new Hono()
    app.use("*", requestLogger)
    app.post("/v1/messages", (c) => {
      logger.warn("routing failed for this request")
      return handleSseStream(c, async (stream) => {
        await Promise.resolve()
        logger.warn("stream producer line")
        await writeSseEvent(stream, "{}", "ping")
      })
    })
    const response = await app.request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.9",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    })
    await response.text()
    const requestId = response.headers.get("x-request-id")
    expect(requestId).toBeTruthy()
    const lines = recentSystemLogs().filter((item) => item.req === requestId)
    expect(lines.map((item) => item.msg)).toEqual([
      "routing failed for this request",
      "stream producer line",
    ])
  } finally {
    resetLoggerForTest()
    logStore.clearForTest()
  }
})
