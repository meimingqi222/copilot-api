/**
 * Windsurf 内容策略拦截的调度语义。
 *
 * 上游把"prompt 命中内容策略"也报成 permission_denied，但它描述的是**请求
 * 内容**，不是账号或线路健康度。旧行为把它归到 unknown → 走 rate-limit 冷却
 * 分支，结果一个客户端的 prompt 把整个账号拖下线，同账号其他客户端跟着吃
 * 429。这里的测试锁定正确语义：400 直接返回、不冷却、不换 target 重试。
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
  getAccountRateLimitSnapshot,
  getRemainingCooldownSeconds,
  resetAdaptiveRateLimiterForTest,
} from "~/lib/rate-limit"
import {
  __resetRouteTargetRoundRobin,
  buildRouteTargets,
  selectRouteTarget,
} from "~/lib/route-target"
import { executeWithFailover } from "~/services/dispatch/failover"
import { WindsurfUpstreamError } from "~/services/windsurf/error-classifier"

import { setTestConnections } from "./helpers/set-connections"

const isolationRoot = PATHS.APP_DIR
let tempAppDir: string

beforeEach(async () => {
  tempAppDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `windsurf-content-policy-${randomUUID()}-`),
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

async function setupWindsurfConnection(id: string, priority: number) {
  return createConnection({
    id,
    name: id,
    protocol: "windsurf-native",
    baseUrl: "",
    priority,
    credentials: [
      { id: `${id}-cred`, value: "windsurf-session-token", authMode: "bearer" },
    ],
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

const CONTENT_POLICY_MESSAGE =
  "permission_denied: Your request was blocked by our content policy. "
  + "Please remove sensitive or unsafe content from your prompt, memories, "
  + "and other settings and try again. (trace ID: abc123)"

describe("windsurf content policy failures", () => {
  test("returns 400 without cooling the connection or failing over", async () => {
    await setupWindsurfConnection("ws-a", 0)
    await setupWindsurfConnection("ws-b", 1)
    const admission = buildAdmissionFor("model-x")
    expect(admission.connection.id).toBe("ws-a")

    const error = new WindsurfUpstreamError(
      {
        kind: "content_policy",
        message: CONTENT_POLICY_MESSAGE,
        code: "permission_denied",
      },
      new Uint8Array(),
    )

    const executed: Array<string> = []
    const thrown = await executeWithFailover({
      payload: { model: "model-x" },
      admission,
      routeKind: "chat",
      execute: (_adapter, target) => {
        executed.push(target.connectionId)
        return Promise.reject(error)
      },
    }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(thrown).toBeInstanceOf(HTTPError)
    expect((thrown as HTTPError).response.status).toBe(400)
    // 同一份 prompt 在任何凭证上都会被拒:不该消耗第二个 target。
    expect(executed).toEqual(["ws-a"])
    expect(getRemainingCooldownSeconds("ws-a")).toBe(0)
    expect(getAccountRateLimitSnapshot("ws-a").consecutive429Count).toBe(0)
    expect(getProviderConnection("ws-a")?.credentials[0]?.cooldownUntil).toBe(
      undefined,
    )
  })

  test("keeps the upstream wording in the client-facing body", async () => {
    await setupWindsurfConnection("ws-a", 0)
    const admission = buildAdmissionFor("model-x")

    const thrown = await executeWithFailover({
      payload: { model: "model-x" },
      admission,
      routeKind: "chat",
      execute: () =>
        Promise.reject(
          new WindsurfUpstreamError(
            {
              kind: "content_policy",
              message: CONTENT_POLICY_MESSAGE,
              code: "permission_denied",
            },
            new Uint8Array(),
          ),
        ),
    }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(thrown).toBeInstanceOf(HTTPError)
    expect((thrown as HTTPError).responseBody).toContain("content policy")
  })

  test("server errors still cool the connection down", async () => {
    await setupWindsurfConnection("ws-a", 0)
    const admission = buildAdmissionFor("model-x")

    const thrown = await executeWithFailover({
      payload: { model: "model-x" },
      admission,
      routeKind: "chat",
      execute: () =>
        Promise.reject(
          new WindsurfUpstreamError(
            {
              kind: "server_error",
              message: "an internal error occurred",
              code: "permission_denied",
            },
            new Uint8Array(),
          ),
        ),
    }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(thrown).toBeInstanceOf(WindsurfUpstreamError)
    expect(getRemainingCooldownSeconds("ws-a")).toBeGreaterThan(0)
  })
})
