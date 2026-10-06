import type { Context } from "hono"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildDumpFileName,
  dumpIncomingRequest,
  dumpUpstreamResponsesWire,
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
  LOG_MAX_FILE_BYTES: process.env["LOG_MAX_FILE_BYTES"],
  LOG_MAX_TOTAL_BYTES: process.env["LOG_MAX_TOTAL_BYTES"],
}

let dumpDir = ""

function readAllEntries(): Array<Record<string, unknown>> {
  const file = path.join(dumpDir, buildDumpFileName(dateKey(), 0))
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

beforeEach(() => {
  dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "request-dump-"))
  process.env["LOG_DIR"] = dumpDir
})

afterEach(() => {
  if (originalEnv.LOG_MAX_TOTAL_BYTES === undefined)
    delete process.env.LOG_MAX_TOTAL_BYTES
  else process.env.LOG_MAX_TOTAL_BYTES = originalEnv.LOG_MAX_TOTAL_BYTES
  if (originalEnv.LOG_MAX_FILE_BYTES === undefined)
    delete process.env.LOG_MAX_FILE_BYTES
  else process.env.LOG_MAX_FILE_BYTES = originalEnv.LOG_MAX_FILE_BYTES
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
  test("cleans expired dumps and recovers after a dump exceeds the budget", async () => {
    process.env.DUMP_REQUESTS = "1"
    process.env.LOG_MAX_TOTAL_BYTES = "1000"
    const expired = path.join(dumpDir, "request-dumps-2000-01-01.jsonl")
    fs.writeFileSync(expired, "expired")
    const send = async (content: string) => {
      const context = await captureContext({
        path: "/v1/responses",
        init: { method: "POST", body: JSON.stringify({ input: content }) },
      })
      await dumpIncomingRequest(context, { requestId: "budget-test" })
    }
    await send("x".repeat(2000))
    expect(fs.existsSync(expired)).toBe(false)
    expect(
      fs
        .readdirSync(dumpDir)
        .filter((name) => name.startsWith("request-dumps-")),
    ).toHaveLength(0)
    await send("hello")
    expect(readAllEntries()).toHaveLength(1)
  })

  test("sanitizes credential headers, nested tool arguments and media before writing", async () => {
    process.env.DUMP_REQUESTS = "1"
    const secretBody = {
      ...payload,
      max_tokens: 42,
      metadata: { refreshToken: "refresh-body-secret", note: "hello" },
      messages: [
        {
          role: "assistant",
          content:
            "Bearer text-body-secret; echoed header-auth-secret header-cookie-secret header-ide-secret",
          tool_calls: [
            {
              function: {
                name: "login",
                arguments: JSON.stringify({
                  password: "tool-password-secret",
                  command: "echo hello",
                }),
              },
            },
          ],
        },
      ],
      image_url: { url: "data:image/png;base64,private-image-content" },
      inlineData: { mimeType: "image/png", data: "gemini-private-image" },
      input_audio: { format: "wav", data: "private-audio" },
      source: { type: "base64", data: "anthropic-private-image" },
      malformedArguments: '{"password":"broken-argument-secret',
      ordinaryBracketText: "[caller] hello",
    }
    const c = await captureContext({
      path: "/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer header-auth-secret",
          "x-ide-token": "header-ide-secret",
          "x-cloudide-token": "header-cloud-secret",
          cookie: "session=header-cookie-secret",
        },
        body: JSON.stringify(secretBody),
      },
    })
    await dumpIncomingRequest(c, { requestId: "redacted-incoming" })
    const [entry] = readDumpEntries()
    const written = JSON.stringify(entry)
    for (const secret of [
      "refresh-body-secret",
      "text-body-secret",
      "tool-password-secret",
      "private-image-content",
      "header-ide-secret",
      "header-cloud-secret",
      "header-cookie-secret",
      "header-auth-secret",
      "gemini-private-image",
      "private-audio",
      "anthropic-private-image",
      "broken-argument-secret",
    ])
      expect(written).not.toContain(secret)
    const body = JSON.parse(entry!.body!)
    expect(body.max_tokens).toBe(42)
    expect(body.metadata.note).toBe("hello")
    expect(body.ordinaryBracketText).toBe("[caller] hello")
    expect(
      JSON.parse(body.messages[0].tool_calls[0].function.arguments).command,
    ).toBe("echo hello")
    // Dumping must not alter the forwarded request.
    expect(await c.req.raw.clone().json()).toEqual(secretBody)
  })

  test("omits malformed and oversized request bodies instead of storing raw prefixes", async () => {
    process.env.DUMP_REQUESTS = "1"
    for (const raw of [
      '{"password":"malformed-secret',
      JSON.stringify({
        password: "oversized-secret",
        padding: "x".repeat(100),
      }),
    ]) {
      process.env.DUMP_REQUESTS_MAX_BYTES = "64"
      const c = await captureContext({
        path: "/v1/messages",
        init: { method: "POST", body: raw },
      })
      await dumpIncomingRequest(c, { requestId: "omitted" })
    }
    const written = JSON.stringify(readDumpEntries())
    expect(written).not.toContain("malformed-secret")
    expect(written).not.toContain("oversized-secret")
  })
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

  test("keeps ordinary headers and body fields for a core API request", async () => {
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
    expect(entry.body).toContain("body omitted")
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

describe("upstream responses wire dump", () => {
  test("JSON preceded by long whitespace still has its secrets and echoes redacted", async () => {
    process.env.DUMP_REQUESTS = "1"
    const body =
      " ".repeat(100)
      + JSON.stringify({
        token: "whitespace-secret",
        echo: "whitespace-secret",
      })
    await dumpUpstreamResponsesWire({
      connectionId: "test",
      model: "test",
      stripMode: "none",
      wire: "test",
      upstreamStatus: 400,
      upstreamBody: body,
      upstreamErrorBody: "whitespace-secret",
    })
    const written = fs.readFileSync(
      path.join(dumpDir, buildDumpFileName(dateKey(), 0)),
      "utf8",
    )
    expect(written).not.toContain("whitespace-secret")
    expect(written).toContain("redacted")
  })

  test("rotation cache honors exact directories and size boundaries", async () => {
    process.env.DUMP_REQUESTS = "1"
    process.env.LOG_MAX_FILE_BYTES = "100000"
    const write = () =>
      dumpUpstreamResponsesWire({
        connectionId: "test",
        model: "test",
        stripMode: "none",
        wire: "test",
        upstreamStatus: 400,
        upstreamBody: "{}",
        upstreamErrorBody: "failed",
      })
    const prefix = path.join(dumpDir, "nested")
    const child = path.join(prefix, "child")
    process.env.DUMP_REQUESTS_DIR = child
    await write()
    process.env.DUMP_REQUESTS_DIR = prefix
    await write()
    const first = path.join(prefix, buildDumpFileName(dateKey(), 0))
    expect(fs.existsSync(first)).toBe(true)
    process.env.LOG_MAX_FILE_BYTES = "1"
    await write()
    expect(
      fs.existsSync(path.join(prefix, buildDumpFileName(dateKey(), 1))),
    ).toBe(true)
    expect(fs.readFileSync(first, "utf8").trim().split("\n")).toHaveLength(1)
  })

  test("bounded dump does not wait for a tee's unread original request", async () => {
    process.env.DUMP_REQUESTS = "1"
    process.env.DUMP_REQUESTS_MAX_BYTES = "32"
    let reads = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        if (reads <= 10)
          controller.enqueue(new TextEncoder().encode("x".repeat(32)))
        else controller.close()
      },
    })
    const app = new Hono()
    let entry: Record<string, unknown> | undefined
    app.post("/v1/responses", async (c) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          dumpIncomingRequest(c, { requestId: "bounded" }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("dump stalled")), 500)
          }),
        ])
        entry = readAllEntries()[0]
        expect(reads).toBeLessThan(10)
        expect((await c.req.text()).length).toBe(320)
        return c.json({ ok: true })
      } finally {
        clearTimeout(timer)
      }
    })
    const response = await app.request("/v1/responses", {
      method: "POST",
      body: stream,
    })
    expect(response.status).toBe(200)
    expect(entry?.truncated).toBe(true)
    expect(entry?.bodyBytes).toBe(64)
  })
  test("sanitizes upstream bodies and error echoes before truncating", async () => {
    process.env.DUMP_REQUESTS = "1"
    await dumpUpstreamResponsesWire({
      connectionId: "test",
      model: "test",
      stripMode: "none",
      wire: "inputItems=1",
      upstreamStatus: 400,
      upstreamBody: JSON.stringify({
        access_token: "upstream-secret",
        input: [{ content: "hello" }],
      }),
      upstreamErrorBody: JSON.stringify({
        error: {
          message: "upstream-secret",
          client_secret: "error-secret",
          detail: JSON.stringify({ api_key: "embedded-secret" }),
        },
      }),
    })
    await dumpUpstreamResponsesWire({
      connectionId: "test",
      model: "test",
      stripMode: "none",
      wire: "inputItems=1",
      upstreamStatus: 400,
      upstreamBody: "{invalid-json upstream-secret",
      upstreamErrorBody:
        'Authorization: Cloud-IDE-JWT plain-jwt-secret; password="two words secret"; accessToken=camel-secret; Cookie: first=cookie-first-secret; second=cookie-second-secret\nurl=https://example.test/?accessToken=url-token-secret&key=url-key-secret',
    })
    const entries = readAllEntries()
    const written = JSON.stringify(entries)
    for (const secret of [
      "upstream-secret",
      "error-secret",
      "embedded-secret",
      "plain-jwt-secret",
      "two words secret",
      "camel-secret",
      "cookie-first-secret",
      "cookie-second-secret",
      "url-token-secret",
      "url-key-secret",
    ])
      expect(written).not.toContain(secret)
    expect(
      JSON.parse(entries[0]!.upstreamBody as string).input[0].content,
    ).toBe("hello")
  })
  test("is disabled unless DUMP_REQUESTS is set", async () => {
    delete process.env["DUMP_REQUESTS"]
    await dumpUpstreamResponsesWire({
      connectionId: "atria",
      model: "Atria-Dawn-Preview",
      stripMode: "replayed",
      wire: "inputItems=3 tools=0",
      upstreamBody: JSON.stringify({ model: "Atria-Dawn-Preview" }),
      upstreamStatus: 400,
      upstreamErrorBody: "upstream_error",
    })

    expect(readAllEntries()).toHaveLength(0)
  })

  test("writes the exact upstream body on failure", async () => {
    process.env["DUMP_REQUESTS"] = "1"
    const upstreamBody = JSON.stringify({
      model: "Atria-Dawn-Preview",
      input: [{ role: "user", content: "hi" }],
      stream: true,
    })

    await dumpUpstreamResponsesWire({
      connectionId: "atria",
      model: "Atria-Dawn-Preview",
      stripMode: "replayed",
      wire: "inputItems=1[userx1] tools=0",
      upstreamBody,
      upstreamStatus: 400,
      upstreamErrorBody: '{"error":{"code":"upstream_error"}}',
    })

    const entries = readAllEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.["kind"]).toBe("upstream-responses")
    expect(entries[0]?.["connectionId"]).toBe("atria")
    expect(entries[0]?.["stripMode"]).toBe("replayed")
    expect(entries[0]?.["upstreamStatus"]).toBe(400)
    expect(entries[0]?.["upstreamBody"]).toBe(upstreamBody)
    expect(entries[0]?.["upstreamBodyTruncated"]).toBeUndefined()
  })

  test("marks oversized upstream bodies as truncated", async () => {
    process.env["DUMP_REQUESTS"] = "1"
    process.env["DUMP_REQUESTS_MAX_BYTES"] = "64"

    await dumpUpstreamResponsesWire({
      connectionId: "atria",
      model: "Atria-Dawn-Preview",
      stripMode: "replayed",
      wire: "inputItems=1",
      upstreamBody: `{"input":"${"x".repeat(500)}"}`,
      upstreamStatus: 400,
      upstreamErrorBody: "err",
    })

    const entries = readAllEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.["upstreamBodyTruncated"]).toBe(true)
    expect(entries[0]?.["upstreamBodyBytes"]).toBeGreaterThan(64)
  })

  test("redacts full credentials before applying the UTF-8 byte limit", async () => {
    process.env.DUMP_REQUESTS = "1"
    process.env.DUMP_REQUESTS_MAX_BYTES = "64"
    await dumpUpstreamResponsesWire({
      connectionId: "test",
      model: "test",
      stripMode: "none",
      wire: "inputItems=0",
      upstreamStatus: 400,
      upstreamBody: JSON.stringify({
        api_key: "secret-prefix-".repeat(100),
        padding: "中文".repeat(100),
      }),
      upstreamErrorBody: 'refreshToken="' + "error-prefix-".repeat(100) + '"',
    })
    const [entry] = readAllEntries()
    expect(JSON.stringify(entry)).not.toContain("secret-prefix-")
    expect(JSON.stringify(entry)).not.toContain("error-prefix-")
    expect(
      Buffer.byteLength(entry!.upstreamBody as string),
    ).toBeLessThanOrEqual(64)
    expect(
      Buffer.byteLength(entry!.upstreamErrorBody as string),
    ).toBeLessThanOrEqual(64)
    expect(entry!.upstreamBodyTruncated).toBe(true)
    expect(entry!.upstreamErrorBodyTruncated).toBe(true)
  })
})
