/**
 * 没有可用路由时的 429 形状。
 *
 * 订阅窗口用尽也是限流:报 `insufficient_quota` 会让 Codex 这类客户端当终态,
 * 窗口恢复后也不会自动继续。这里锁住"报 rate_limit_exceeded,并带上窗口的
 * 剩余时间"。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  getProviderConnection,
} from "~/lib/provider-connections"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { clearRestRegistryForTest } from "~/lib/route-target"
import { state } from "~/lib/state"
import { server } from "~/server"

import { setTestConnections } from "./helpers/set-connections"

const isolationRoot = PATHS.APP_DIR
const originalApiKey = state.legacyApiKey
let tempAppDir: string

beforeEach(async () => {
  tempAppDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `quota-wire-${randomUUID()}-`),
  )
  redirectPathsToDir(tempAppDir)
  resetAdaptiveRateLimiterForTest()
  resetProtectedRouteGuardForTest()
  clearRestRegistryForTest()
  state.legacyApiKey = undefined
  setTestConnections([])
})

afterEach(async () => {
  redirectPathsToDir(isolationRoot)
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
  clearRestRegistryForTest()
  state.legacyApiKey = originalApiKey
  setTestConnections([])
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
})

/** 一条配额耗尽的连接:窗口还剩 cooldownUntil - now。 */
async function exhaustedConnection(id: string, cooldownUntil: number) {
  await createConnection({
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: `https://${id}.example.com/v1`,
    priority: 0,
    credentials: [{ id: `${id}-cred`, value: "sk-test", authMode: "bearer" }],
    models: [
      {
        publicId: "quota-model",
        upstreamId: "quota-model",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })
  const conn = getProviderConnection(id)
  if (!conn) throw new Error(`missing connection ${id}`)
  conn.credentials[0].status = "quota_exhausted"
  conn.credentials[0].cooldownUntil = cooldownUntil
}

describe("exhausted price window", () => {
  test("answers a retryable rate limit with the window's remaining time", async () => {
    const fiveHours = 5 * 60 * 60 * 1000
    await exhaustedConnection("quota-window", Date.now() + fiveHours)

    const response = await server.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "quota-model", input: "hi" }),
    })

    expect(response.status).toBe(429)
    expect(response.headers.get("content-type")).toBe("application/json")
    const retryAfter = Number(response.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThan(fiveHours / 1000 - 10)
    expect(retryAfter).toBeLessThanOrEqual(fiveHours / 1000)
    const body = (await response.json()) as {
      error: { code: string; type: string }
    }
    expect(body.error.code).toBe("rate_limit_exceeded")
    expect(body.error.type).toBe("rate_limit_exceeded")
  })
})
