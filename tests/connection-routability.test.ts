/**
 * getConnectionRoutability 收敛测试:三处旧判断
 * (build 门禁 / admission 诊断 / credential 状态)的并集语义。
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
  getConnectionRoutability,
  getProviderConnection,
  markCredentialAuthError,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  setConnectionAuthStatus,
  setConnectionQuotaState,
  setCredentialEnabled,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  reportUpstreamRateLimitMs,
  resetAdaptiveRateLimiterForTest,
} from "~/lib/rate-limit"

import { setTestConnections } from "./helpers/set-connections"

const isolationRoot = PATHS.APP_DIR
let tempAppDir: string

beforeEach(async () => {
  tempAppDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `routability-test-${randomUUID()}-`),
  )
  redirectPathsToDir(tempAppDir)
  resetAdaptiveRateLimiterForTest()
})

afterEach(async () => {
  redirectPathsToDir(isolationRoot)
  __resetProviderConnectionsForTest()
  resetAdaptiveRateLimiterForTest()
  setTestConnections([])
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
})

async function setupConnection(id: string): Promise<ProviderConnection> {
  const conn = await createConnection({
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: `https://${id}.example.com/v1`,
    priority: 0,
    credentials: [{ id: `${id}-cred`, value: "sk-test", authMode: "bearer" }],
    models: [
      {
        publicId: "model-x",
        upstreamId: "model-x",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
  })
  return conn
}

function mustGet(id: string): ProviderConnection {
  const conn = getProviderConnection(id)
  if (!conn) throw new Error(`missing connection ${id}`)
  return conn
}

describe("getConnectionRoutability", () => {
  test("ready connection is routable", async () => {
    await setupConnection("c1")
    expect(getConnectionRoutability(mustGet("c1"))).toEqual({
      routable: true,
      reason: "available",
      retryAfterSeconds: 0,
    })
  })

  test("disabled connection is excluded even with ready credentials", async () => {
    const conn = await setupConnection("c1")
    conn.enabled = false
    const result = getConnectionRoutability(mustGet("c1"))
    expect(result.routable).toBe(false)
    expect(result.reason).toBe("disabled")
  })

  test("primary credential disabled excludes the connection", async () => {
    await setupConnection("c1")
    const conn = mustGet("c1")
    setCredentialEnabled(conn.credentials[0], false)
    const result = getConnectionRoutability(mustGet("c1"))
    expect(result.routable).toBe(false)
    expect(result.reason).toBe("disabled")
  })

  test("credential auth_error excludes the connection", async () => {
    await setupConnection("c1")
    const conn = mustGet("c1")
    markCredentialAuthError(conn.credentials[0], "bad key")
    const result = getConnectionRoutability(mustGet("c1"))
    expect(result.routable).toBe(false)
    expect(result.reason).toBe("auth_error")
  })

  test("connection-level legacy authStatus error excludes the connection", async () => {
    await setupConnection("c1")
    const conn = mustGet("c1")
    setConnectionAuthStatus(conn, "error", "legacy mirror")
    // 只保留 metadata 侧,credential 侧恢复 ready,验证取并集。
    conn.credentials[0].status = "ready"
    const result = getConnectionRoutability(mustGet("c1"))
    expect(result.routable).toBe(false)
    expect(result.reason).toBe("auth_error")
  })

  test("limiter cooldown excludes with retry hint", async () => {
    await setupConnection("c1")
    await reportUpstreamRateLimitMs("c1", 5000)
    const result = getConnectionRoutability(mustGet("c1"))
    expect(result.routable).toBe(false)
    expect(result.reason).toBe("cooldown")
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })

  test("credential quota with future cooldown surfaces as cooldown", async () => {
    // 限流器内存可从 credentials[0].cooldownUntil 同步,冷却检查排在配额之前
    // (与旧门禁/旧诊断一致);配额分支只处理无未来 cooldown 的残留状态。
    await setupConnection("c1")
    const conn = mustGet("c1")
    markCredentialQuotaExhausted(conn.credentials[0], "plan depleted")
    const result = getConnectionRoutability(mustGet("c1"))
    expect(result.routable).toBe(false)
    expect(result.reason).toBe("cooldown")
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })

  test("stale quota status without cooldown surfaces as quota", async () => {
    await setupConnection("c1")
    const conn = mustGet("c1")
    conn.credentials[0].status = "quota_exhausted"
    conn.credentials[0].cooldownUntil = undefined
    const result = getConnectionRoutability(mustGet("c1"))
    expect(result.routable).toBe(false)
    expect(result.reason).toBe("quota_exhausted")
  })

  test("metadata-only quota residue does not exclude (credential-derived)", async () => {
    // getConnectionQuotaState 自 T5.2.5 起从 credential.status 派生,不再读
    // metadata.quotaState;因此 metadata 残留不影响调度(与旧门禁一致)。
    await setupConnection("c1")
    const conn = mustGet("c1")
    setConnectionQuotaState(conn, "exhausted")
    // 只保留 metadata 侧,credential 侧恢复 ready。
    conn.credentials[0].status = "ready"
    conn.credentials[0].cooldownUntil = undefined
    const result = getConnectionRoutability(mustGet("c1"))
    expect(result.routable).toBe(true)
    expect(result.reason).toBe("available")
  })

  test("short credential cooldown excludes the connection", async () => {
    await setupConnection("c1")
    const conn = mustGet("c1")
    markCredentialCooldown(conn.credentials[0], {
      retryAfterMs: 30_000,
      reason: "upstream 429",
    })
    const result = getConnectionRoutability(mustGet("c1"))
    expect(result.routable).toBe(false)
    // credential.cooldownUntil 同步进 limiter 内存,走 cooldown 分支。
    expect(result.reason).toBe("cooldown")
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })
})
