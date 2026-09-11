import type { Context } from "hono"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildDumpFileName,
  dumpIncomingRequest,
  isRequestDumpEnabled,
} from "~/lib/request-dump"

interface DumpEntry {
  requestId: string
  method: string
  path: string
  clientIp?: string
  userAgent?: string
  headers: Record<string, string>
  body?: string
  bodyBytes?: number
  truncated: boolean
}

const originalEnv = {
  DUMP_REQUESTS: process.env["DUMP_REQUESTS"],
  DUMP_REQUESTS_DIR: process.env["DUMP_REQUESTS_DIR"],
  DUMP_REQUESTS_MAX_BYTES: process.env["DUMP_REQUESTS_MAX_BYTES"],
  LOG_DIR: process.env["LOG_DIR"],
}

let dumpDir = ""

beforeEach(() => {
  dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "request-dump-"))
  process.env["LOG_DIR"] = dumpDir
})

afterEach(() => {
  if (originalEnv.DUMP_REQUESTS === undefined) delete process.env.DUMP_REQUESTS
  else process.env.DUMP_REQUESTS = originalEnv.DUMP_REQUESTS
  if (originalEnv.DUMP_REQUESTS_DIR === undefined)
    delete process.env.DUMP_REQUESTS_DIR
  else process.env.DUMP_REQUESTS_DIR = originalEnv.DUMP_REQUESTS_DIR
  if (originalEnv.DUMP_REQUESTS_MAX_BYTES === undefined)
    delete process.env.DUMP_REQUESTS_MAX_BYTES
  else process.env.DUMP_REQUESTS_MAX_BYTES = originalEnv.DUMP_REQUESTS_MAX_BYTES
  if (originalEnv.LOG_DIR === undefined) delete process.env.LOG_DIR
  else process.env.LOG_DIR = originalEnv.LOG_DIR
  fs.rmSync(dumpDir, { recursive: true, force: true })
})

function captureContext(c: {
  path: string
  init: RequestInit
}): Promise<Context> {
  const app = new Hono()
  let captured: Context | undefined
  app.use("*", async (ctx, next) => {
    captured = ctx
    await next()
  })
  app.all("*", (ctx) => ctx.json({ ok: true }))
  return (async () => {
    await app.request(c.path, c.init)
    if (!captured) throw new Error("context not captured")
    return captured
  })()
}

function readDumpEntries(): Array<DumpEntry> {
  const file = path.join(dumpDir, buildDumpFileName(dateKey(), 0))
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DumpEntry)
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0")
}

function dateKey(): string {
  const now = new Date()
  return `${now.getFullYear()}-${padDatePart(now.getMonth() + 1)}-${padDatePart(now.getDate())}`
}

const payload = {
  model: "claude-opus-5-medium",
  messages: [{ role: "user", content: "hello" }],
  stream: true,
}

describe("request dump", () => {
  test("is disabled unless DUMP_REQUESTS is set", async () => {
    delete process.env["DUMP_REQUESTS"]
    expect(isRequestDumpEnabled()).toBe(false)

    const c = await captureContext({
      path: "/v1/chat/completions",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    })
    await dumpIncomingRequest(c, { requestId: "r1", clientIp: "127.0.0.1" })

    expect(readDumpEntries()).toHaveLength(0)
  })

  test("writes raw headers and body for a core API request", async () => {
    process.env["DUMP_REQUESTS"] = "1"

    const c = await captureContext({
      path: "/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "ZCode/1.0",
          "x-claude-code-session-id": "session-abc",
        },
        body: JSON.stringify(payload),
      },
    })
    await dumpIncomingRequest(c, { requestId: "r2", clientIp: "127.0.0.1" })

    const entries = readDumpEntries()
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry.requestId).toBe("r2")
    expect(entry.method).toBe("POST")
    expect(entry.path).toBe("/v1/chat/completions")
    expect(entry.clientIp).toBe("127.0.0.1")
    expect(entry.userAgent).toBe("ZCode/1.0")
    expect(entry.headers["x-claude-code-session-id"]).toBe("session-abc")
    expect(entry.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(entry.body ?? "{}")).toEqual(payload)
    expect(entry.truncated).toBe(false)
  })

  test("redacts credential headers but keeps their length", async () => {
    process.env["DUMP_REQUESTS"] = "1"

    const c = await captureContext({
      path: "/v1/messages",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer super-secret-key",
          "x-api-key": "another-secret",
        },
        body: JSON.stringify(payload),
      },
    })
    await dumpIncomingRequest(c, { requestId: "r3" })

    const [entry] = readDumpEntries()
    expect(entry.headers["authorization"]).toMatch(/^\[redacted:\d+\]$/)
    expect(entry.headers["x-api-key"]).toMatch(/^\[redacted:\d+\]$/)
    expect(JSON.stringify(entry)).not.toContain("super-secret-key")
    expect(JSON.stringify(entry)).not.toContain("another-secret")
  })

  test("skips paths outside the core API surface", async () => {
    process.env["DUMP_REQUESTS"] = "1"

    const c = await captureContext({
      path: "/admin/api/logs",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "hunter2" }),
      },
    })
    await dumpIncomingRequest(c, { requestId: "r4" })

    expect(readDumpEntries()).toHaveLength(0)
  })

  test("marks oversized bodies as truncated", async () => {
    process.env["DUMP_REQUESTS"] = "1"
    process.env["DUMP_REQUESTS_MAX_BYTES"] = "64"

    const c = await captureContext({
      path: "/v1/responses",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, padding: "x".repeat(500) }),
      },
    })
    await dumpIncomingRequest(c, { requestId: "r5" })

    const [entry] = readDumpEntries()
    expect(entry.truncated).toBe(true)
    expect(entry.bodyBytes).toBeGreaterThan(64)
    expect((entry.body ?? "").length).toBe(64)
  })

  test("honours DUMP_REQUESTS_DIR", async () => {
    const customDir = path.join(dumpDir, "custom")
    process.env["DUMP_REQUESTS"] = "1"
    process.env["DUMP_REQUESTS_DIR"] = customDir

    const c = await captureContext({
      path: "/v1/chat/completions",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    })
    await dumpIncomingRequest(c, { requestId: "r6" })

    const file = path.join(customDir, buildDumpFileName(dateKey(), 0))
    expect(fs.existsSync(file)).toBe(true)
    expect(readDumpEntries()).toHaveLength(0)
  })
})
