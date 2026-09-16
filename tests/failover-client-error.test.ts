/**
 * Failover 冷却语义:400/401 等客户端错误不应进 cooldown。
 *
 * 回归:atria 等第三方 responses 中转对 `previous_response_id` 回 400
 * `upstream_error` 时,旧逻辑按 COOLDOWN_5XX_MS=30s 冷却 credential,
 * 导致 30s 内所有请求误报 429 "all providers are temporarily rate-limited"。
 * 与 shared.handleUpstreamFailure / account-managed 路径保持一致:
 * client_error 只记 lastError,auth_error 标记 auth_error,仅 429/5xx/网络错误冷却。
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
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
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
    path.join(os.tmpdir(), `failover-client-error-${randomUUID()}-`),
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

async function setupResponsesConnection(id: string) {
  return createConnection({
    id,
    name: id,
    protocol: "openai-responses-compatible",
    baseUrl: `https://${id}.example.com/v1`,
    priority: 10,
    credentials: [{ id: `${id}-cred`, value: "sk-test", authMode: "bearer" }],
    models: [
      {
        publicId: "Atria-Dawn-Preview",
        upstreamId: "Atria-Dawn-Preview",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })
}

function buildResponsesAdmission(): ProviderAdmission {
  const targets = buildRouteTargets({
    publicModelId: "Atria-Dawn-Preview",
    endpoint: "responses",
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

function httpError(status: number, body: string): HTTPError {
  return new HTTPError(
    `upstream ${status}`,
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    }),
    body,
  )
}

describe("executeWithFailover client-error cooldown", () => {
  test("400 upstream_error does not cool down the credential", async () => {
    await setupResponsesConnection("atria")
    const admission = buildResponsesAdmission()

    const error = await executeWithFailover({
      payload: { model: "Atria-Dawn-Preview" },
      admission,
      routeKind: "responses",
      execute: () => {
        throw httpError(
          400,
          JSON.stringify({
            error: {
              type: "upstream_error",
              message: "bad previous_response_id",
            },
          }),
        )
      },
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HTTPError)
    expect((error as HTTPError).response.status).toBe(400)
    const cred = getProviderConnection("atria")?.credentials[0]
    expect(cred?.status).toBe("ready")
    expect(cred?.cooldownUntil).toBeUndefined()
  })

  test("401 marks auth_error instead of cooldown", async () => {
    await setupResponsesConnection("atria")
    const admission = buildResponsesAdmission()

    const error = await executeWithFailover({
      payload: { model: "Atria-Dawn-Preview" },
      admission,
      routeKind: "responses",
      execute: () => {
        throw httpError(
          401,
          JSON.stringify({ error: { message: "invalid api key" } }),
        )
      },
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HTTPError)
    const cred = getProviderConnection("atria")?.credentials[0]
    expect(cred?.status).toBe("auth_error")
    expect(cred?.cooldownUntil).toBeUndefined()
  })

  test("500 still cools down the credential", async () => {
    await setupResponsesConnection("atria")
    const admission = buildResponsesAdmission()

    const error = await executeWithFailover({
      payload: { model: "Atria-Dawn-Preview" },
      admission,
      routeKind: "responses",
      execute: () => {
        throw httpError(500, "internal error")
      },
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HTTPError)
    const cred = getProviderConnection("atria")?.credentials[0]
    expect(cred?.status).toBe("cooldown")
    expect(cred?.cooldownUntil).toBeGreaterThan(Date.now())
  })
})
