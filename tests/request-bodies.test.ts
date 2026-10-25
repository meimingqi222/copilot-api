import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { logStore } from "~/lib/log-store"
import {
  clearFailureWiresForTest,
  dumpUpstreamResponsesWire,
  getFailureWire,
  readDumpedRequestBodies,
} from "~/lib/request-dump"
import { server } from "~/server"

import { adminRequest, setupAdminAuth } from "./admin-test-utils"

const originalDumpDir = process.env.DUMP_REQUESTS_DIR
let dumpDir: string

beforeEach(() => {
  clearFailureWiresForTest()
  logStore.clearForTest()
  dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "request-dumps-"))
  process.env.DUMP_REQUESTS_DIR = dumpDir
})

afterEach(() => {
  if (originalDumpDir === undefined) delete process.env.DUMP_REQUESTS_DIR
  else process.env.DUMP_REQUESTS_DIR = originalDumpDir
  fs.rmSync(dumpDir, { recursive: true, force: true })
})

async function recordFailure(requestId: string, status = 400) {
  await dumpUpstreamResponsesWire({
    requestId,
    connectionId: "conn-1",
    model: "gpt-test",
    stripMode: "passthrough",
    wire: "input=1",
    upstreamBody: JSON.stringify({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      api_key: "sk-should-not-leak",
    }),
    upstreamStatus: status,
    upstreamErrorBody: JSON.stringify({
      error: "invalid_request",
      token: "tok-should-not-leak",
    }),
  })
}

describe("upstream failure bodies", () => {
  test("keeps the last failures in memory even when disk dumping is off", async () => {
    await recordFailure("req-fail")

    const wire = getFailureWire("req-fail")
    expect(wire).toBeDefined()
    expect(wire?.upstreamStatus).toBe(400)
    expect(wire?.upstreamBody).toContain("hello")
    expect(wire?.upstreamErrorBody).toContain("invalid_request")
    expect(wire?.upstreamBody).not.toContain("sk-should-not-leak")
    expect(wire?.upstreamErrorBody).not.toContain("tok-should-not-leak")
  })

  test("evicts the oldest failure first", async () => {
    for (let index = 0; index < 51; index += 1) {
      await recordFailure(`req-${index}`)
    }
    expect(getFailureWire("req-0")).toBeUndefined()
    expect(getFailureWire("req-50")).toBeDefined()
  })

  test("reads incoming and upstream entries from the dump archive", async () => {
    const file = path.join(dumpDir, "request-dumps-2026-10-25.jsonl")
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          timestamp: 1,
          requestId: "req-archived",
          method: "POST",
          path: "/v1/responses",
          headers: { "content-type": "application/json" },
          body: '{"input":"from client"}',
          bodyBytes: 24,
          truncated: false,
        }),
        JSON.stringify({
          kind: "upstream-responses",
          timestamp: 2,
          requestId: "req-archived",
          connectionId: "conn-9",
          model: "gpt-test",
          stripMode: "replayed",
          upstreamBody: '{"input":"sent upstream"}',
          upstreamBodyBytes: 25,
          upstreamStatus: 400,
          upstreamErrorBody: '{"error":"bad"}',
          upstreamErrorBodyBytes: 15,
        }),
      ].join("\n") + "\n",
    )

    const found = await readDumpedRequestBodies("req-archived")
    expect(found?.incoming?.body).toContain("from client")
    expect(found?.upstream?.body).toContain("sent upstream")
    expect(found?.upstream?.errorBody).toContain("bad")
    expect(found?.upstream?.upstreamStatus).toBe(400)
    expect(await readDumpedRequestBodies("req-missing")).toBeUndefined()
  })

  test("serves bodies on demand for a logged request", async () => {
    setupAdminAuth()
    logStore.push({
      timestamp: Date.now(),
      level: "error",
      message: "POST /v1/responses 400",
      requestId: "req-api",
      statusCode: 400,
      outcome: "failed",
    })
    await recordFailure("req-api")

    const response = await server.fetch(
      adminRequest("http://localhost/admin/api/logs/req-api/bodies"),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      available: boolean
      request: unknown
      upstreamRequest: { body: string; model: string } | null
      response: { status: number; body: string } | null
    }
    expect(body.available).toBe(true)
    expect(body.request).toBeNull()
    expect(body.upstreamRequest?.model).toBe("gpt-test")
    expect(body.upstreamRequest?.body).toContain("hello")
    expect(body.response?.status).toBe(400)
    expect(body.response?.body).toContain("invalid_request")
  })
})
