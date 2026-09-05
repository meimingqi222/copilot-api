/**
 * Pacing 门禁集成测试:executeWithFailover 内的 checkRateLimit /
 * reportUpstreamSuccess / 队列满轮转行为。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ProviderAdmission } from "~/lib/request-admission"

import { HTTPError } from "~/lib/error"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  getProviderConnection,
} from "~/lib/provider-connections"
import {
  checkRateLimit,
  getAccountRateLimitSnapshot,
  getRemainingCooldownSeconds,
  holdLimiterLockForTest,
  reportUpstreamRateLimitMs,
  resetAdaptiveRateLimiterForTest,
} from "~/lib/rate-limit"
import {
  __resetRouteTargetRoundRobin,
  buildRouteTargets,
  selectRouteTarget,
} from "~/lib/route-target"
import { executeWithFailover } from "~/services/dispatch/failover"

import { setTestConnections } from "./helpers/set-connections"

const isolationRoot = PATHS.APP_DIR
let tempAppDir: string

beforeEach(async () => {
  tempAppDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `failover-pacing-test-${randomUUID()}-`),
  )
  redirectPathsToDir(tempAppDir)
  resetAdaptiveRateLimiterForTest()
})

afterEach(async () => {
  redirectPathsToDir(isolationRoot)
  __resetProviderConnectionsForTest()
  __resetRouteTargetRoundRobin()
  resetAdaptiveRateLimiterForTest()
  setTestConnections([])
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
})

async function setupConnection(id: string, priority: number) {
  return createConnection({
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: `https://${id}.example.com/v1`,
    priority,
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
}

function buildAdmissionFor(modelId: string): ProviderAdmission {
  const targets = buildRouteTargets({
    publicModelId: modelId,
    endpoint: "chat",
  })
  const selected = selectRouteTarget(targets)
  expect(selected).not.toBeNull()
  const conn = getProviderConnection(
    (selected as NonNullable<typeof selected>).connectionId,
  )
  expect(conn).not.toBeNull()
  const connection = conn as NonNullable<typeof conn>
  return {
    target: selected as NonNullable<typeof selected>,
    connection,
    credential: connection.credentials[0],
    initiator: "user",
  }
}

/**
 * 确定性地打满指定 connection 的 pacing 队列(MAX_QUEUE_SIZE)。
 * 原理:先占住 limiter 锁,再同步触发足够多的 checkRateLimit 调用——
 * 每次调用在首个 await 之前同步完成入队计数,因此触发完成后队列必满。
 */
async function saturatePacingQueue(accountId: string) {
  const ac = new AbortController()
  const holder = holdLimiterLockForTest(accountId, 1000)
  const waiters = Array.from({ length: 105 }, () =>
    checkRateLimit(accountId, ac.signal).catch((e: unknown) => e),
  )
  return {
    release: async () => {
      ac.abort()
      await Promise.allSettled(waiters)
      await holder
    },
  }
}

describe("executeWithFailover pacing gate", () => {
  test("successful execute passes the pacing gate and resets 429 pressure", async () => {
    await setupConnection("conn", 0)
    const admission = buildAdmissionFor("model-x")

    await reportUpstreamRateLimitMs("conn", 50)
    expect(getAccountRateLimitSnapshot("conn").consecutive429Count).toBe(1)

    const result = await executeWithFailover({
      payload: { model: "model-x" },
      admission,
      routeKind: "chat",
      execute: () => Promise.resolve("ok"),
    })

    expect(result).toBe("ok")
    expect(getAccountRateLimitSnapshot("conn").consecutive429Count).toBe(0)
  })

  test("queue-full rotates to the next target without cooling anything", async () => {
    await setupConnection("conn", 0)
    await setupConnection("acc", 5)
    const admission = buildAdmissionFor("model-x")
    expect(admission.connection.id).toBe("conn")

    const saturation = await saturatePacingQueue("conn")
    try {
      const executed: Array<string> = []
      const result = await executeWithFailover({
        payload: { model: "model-x" },
        admission,
        routeKind: "chat",
        execute: (_adapter, target) => {
          executed.push(target.connectionId)
          if (target.connectionId === "conn") {
            throw new Error("saturated connection must not execute")
          }
          return Promise.resolve("from-acc")
        },
      })

      expect(result).toBe("from-acc")
      expect(executed).toEqual(["acc"])
      // 本地饱和不是上游失败:不写任何冷却。
      expect(getRemainingCooldownSeconds("conn")).toBe(0)
      expect(
        getProviderConnection("conn")?.credentials[0]?.cooldownUntil ?? 0,
      ).toBe(0)
    } finally {
      await saturation.release()
    }
  })

  test("queue-full with no targets left surfaces a retryable 429", async () => {
    await setupConnection("conn", 0)
    const admission = buildAdmissionFor("model-x")

    const saturation = await saturatePacingQueue("conn")
    try {
      const error = await executeWithFailover({
        payload: { model: "model-x" },
        admission,
        routeKind: "chat",
        execute: () => Promise.resolve("unreachable"),
      }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(error).toBeInstanceOf(HTTPError)
      expect((error as HTTPError).response.status).toBe(429)
    } finally {
      await saturation.release()
    }
  })
})
