/**
 * 没有可用路由时的 429 形状。
 *
 * 订阅窗口用尽也是限流:报 `insufficient_quota` 会让 Codex 这类客户端当终态,
 * 窗口恢复后也不会自动继续。这里锁住"报 rate_limit_exceeded,并带上窗口的
 * 剩余时间"。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Hono } from "hono"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { HTTPError, forwardError } from "~/lib/error"
import * as planQuotaStore from "~/lib/plan-quota/store"
import { __resetPlanAllowanceMirrorForTest } from "~/lib/plan-quota/apply"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  getProviderConnection,
  setConnectionCooldownUntil,
  type ProviderProtocol,
} from "~/lib/provider-connections"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { applyOAuthQuotaSnapshot } from "~/lib/quota"
import { fetchCodexQuota } from "~/lib/quota/fetchers/codex"
import {
  buildRouteTargets,
  clearRestRegistryForTest,
  routeEvidenceFor,
} from "~/lib/route-target"
import { state } from "~/lib/state"
import { server } from "~/server"
import { executeWithFailover } from "~/services/dispatch/failover"

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

async function setupConnection(
  id: string,
  cooldownUntil?: number,
  protocol: ProviderProtocol = "openai-compatible",
) {
  await createConnection({
    id,
    name: id,
    protocol,
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
  if (cooldownUntil !== undefined) {
    conn.credentials[0].status = "quota_exhausted"
    conn.credentials[0].cooldownUntil = cooldownUntil
  }
  return conn
}

describe("exhausted price window", () => {
  test.each(["review", "feature"] as const)(
    "Codex isolated %s exhaustion does not exclude a funded coding account",
    async (bucket) => {
      const backup = await setupConnection(
        "review-spent",
        undefined,
        "codex-native",
      )
      await setupConnection(
        "coding-spent",
        Date.now() + 8_025_000,
        "codex-native",
      )
      const window = { limit_window_seconds: 18000, reset_after_seconds: 3600 }
      let codingUsed = 25
      let featureUsed = 100
      const fetch = spyOn(globalThis, "fetch").mockImplementation(((
        input: Parameters<typeof globalThis.fetch>[0],
      ) => {
        const url = String(input)
        if (url.endsWith("/wham/usage")) {
          return Promise.resolve(
            Response.json({
              rate_limit: {
                primary_window: { ...window, used_percent: codingUsed },
              },
              ...(bucket === "review" ?
                {
                  code_review_rate_limit: {
                    primary_window: { ...window, used_percent: featureUsed },
                  },
                }
              : {
                  additional_rate_limits: [
                    {
                      limit_name: "GPT-5.3-Codex-Spark",
                      metered_feature: "codex_bengalfox",
                      rate_limit: {
                        primary_window: {
                          ...window,
                          used_percent: featureUsed,
                        },
                      },
                    },
                  ],
                }),
            }),
          )
        }
        if (url.endsWith("/rate-limit-reset-credits")) {
          return Promise.resolve(Response.json({ available_count: 0 }))
        }
        throw new Error(`Unexpected upstream ${url}`)
      }) as typeof globalThis.fetch)
      // Persistence has its own suite; this route test must not leave queued disk writes.
      const allowanceWrite = spyOn(
        planQuotaStore,
        "mergeWithLast",
      ).mockResolvedValue({ windows: [], stale: false })
      __resetPlanAllowanceMirrorForTest()
      try {
        const snapshot = await fetchCodexQuota(backup)
        expect(snapshot.premiumInteractionsRemaining).toBe(75)
        // Keep independent feature budgets visible, but do not route ordinary coding by them.
        expect(snapshot.details?._quotaWindows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id:
                bucket === "review" ?
                  "code-review-five-hour"
                : "gpt-5-3-codex-spark-five-hour-0",
              usedPercent: 100,
            }),
          ]),
        )
        applyOAuthQuotaSnapshot(backup, snapshot)
        expect(
          buildRouteTargets({
            publicModelId: "quota-model",
            endpoint: "responses",
          }).map((candidate) => candidate.connectionId),
        ).toEqual(["review-spent"])
        expect(
          routeEvidenceFor(backup.id, backup.credentials[0].id, "gpt-6.1-sol")
            .quota?.usedFraction,
        ).toBe(0.25)

        // The opposite case is still genuinely depleted: other budgets cannot rescue coding.
        codingUsed = 100
        featureUsed = 0
        applyOAuthQuotaSnapshot(backup, await fetchCodexQuota(backup))
        expect(
          buildRouteTargets({
            publicModelId: "quota-model",
            endpoint: "responses",
          }),
        ).toEqual([])

        codingUsed = 25
        featureUsed = 100
        applyOAuthQuotaSnapshot(backup, await fetchCodexQuota(backup))
        expect(
          buildRouteTargets({
            publicModelId: "quota-model",
            endpoint: "responses",
          }).map((candidate) => candidate.connectionId),
        ).toEqual(["review-spent"])
      } finally {
        await Promise.resolve()
        allowanceWrite.mockRestore()
        __resetPlanAllowanceMirrorForTest()
        fetch.mockRestore()
      }
    },
  )

  test("answers a retryable rate limit with the window's remaining time", async () => {
    const fiveHours = 5 * 60 * 60 * 1000
    await setupConnection("quota-window", Date.now() + fiveHours)

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

  test.each(["codex-native", "openai-compatible"] as const)(
    "%s: a depleted account must not extend another account's 520 retry",
    async (protocol) => {
      const now = Date.now()
      await setupConnection("spent", now + 8_025_000, protocol)
      const backup = await setupConnection("backup", undefined, protocol)
      const target = buildRouteTargets({
        publicModelId: "quota-model",
        endpoint: "responses",
      })[0]
      expect(target.connectionId).toBe("backup")
      const admission = {
        target,
        connection: backup,
        credential: backup.credentials[0],
      }
      await expect(
        executeWithFailover({
          payload: { model: "quota-model" },
          admission,
          routeKind: "responses",
          execute: () => {
            throw new HTTPError(
              "upstream 520",
              new Response(null, { status: 520 }),
              "<html>upstream unavailable</html>",
            )
          },
        }),
      ).rejects.toBeInstanceOf(HTTPError)

      // Concurrent failures can leave a shorter persisted wait beside the 520 rest.
      if (protocol === "codex-native") {
        setConnectionCooldownUntil(backup, Date.now() + 30_000)
      }
      // Disabled credentials are not routes that will recover in ten seconds.
      const disabled = await setupConnection("disabled", now + 10_000, protocol)
      disabled.credentials[0].enabled = false

      const response = await server.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "quota-model", input: "hi" }),
      })
      expect(response.status).toBe(429)
      const retryAfter = Number(response.headers.get("retry-after"))
      expect(retryAfter).toBeGreaterThan(55)
      expect(retryAfter).toBeLessThanOrEqual(60)
      expect(Number(response.headers.get("retry-after-ms"))).toBe(
        retryAfter * 1000,
      )

      const clock = spyOn(Date, "now").mockReturnValue(now + 31_000)
      try {
        expect(
          buildRouteTargets({
            publicModelId: "quota-model",
            endpoint: "responses",
          }),
        ).toEqual([])
        clock.mockReturnValue(now + 61_000)
        const recovered = buildRouteTargets({
          publicModelId: "quota-model",
          endpoint: "responses",
        })
        expect(recovered.map((candidate) => candidate.connectionId)).toEqual([
          "backup",
        ])
        expect(
          await executeWithFailover({
            payload: { model: "quota-model" },
            admission: { ...admission, target: recovered[0] },
            routeKind: "responses",
            execute: () => Promise.resolve("served by backup"),
          }),
        ).toBe("served by backup")
      } finally {
        clock.mockRestore()
      }
    },
  )

  test.each([429, 520])(
    "Codex switches to a healthy account after upstream %s",
    async (status) => {
      const primary = await setupConnection(
        "primary",
        undefined,
        "codex-native",
      )
      await setupConnection("healthy", undefined, "codex-native")
      const target = buildRouteTargets({
        publicModelId: "quota-model",
        endpoint: "responses",
      }).find((candidate) => candidate.connectionId === "primary")!
      const attempts: string[] = []
      const result = await executeWithFailover({
        payload: { model: "quota-model" },
        admission: {
          target,
          connection: primary,
          credential: primary.credentials[0],
        },
        routeKind: "responses",
        execute: (_adapter, selected) => {
          attempts.push(selected.connectionId)
          if (selected.connectionId === "primary") {
            const body =
              status === 429 ?
                JSON.stringify({
                  error: {
                    type: "usage_limit_reached",
                    resets_in_seconds: 8025,
                  },
                })
              : "<html>upstream unavailable</html>"
            throw new HTTPError(
              "upstream failure",
              new Response(null, { status }),
              body,
            )
          }
          return Promise.resolve("served by healthy account")
        },
      })
      expect(result).toBe("served by healthy account")
      expect(attempts).toEqual(["primary", "healthy"])
      expect(
        buildRouteTargets({
          publicModelId: "quota-model",
          endpoint: "responses",
        }).map((candidate) => candidate.connectionId),
      ).toEqual(["healthy"])
    },
  )

  test.each([
    "body",
    "header",
    "group",
    "messages",
    "pinned",
    "stream-400",
  ] as const)(
    "continuous failover uses the earliest eligible account recovery: %s",
    async (mode) => {
      const network = await setupConnection(
        "network",
        undefined,
        "codex-native",
      )
      const spent = await setupConnection("spent", undefined, "codex-native")
      const endpoint = mode === "messages" ? "messages" : "responses"
      const model = mode === "pinned" ? "spent/quota-model" : "quota-model"
      const first = mode === "pinned" ? spent : network
      if (mode === "pinned") {
        network.credentials[0].status = "cooldown"
        network.credentials[0].cooldownUntil = Date.now() + 60_000
      }
      if (mode === "group") {
        await setupConnection(
          "outside-group",
          Date.now() + 10_000,
          "codex-native",
        )
      }
      const target = buildRouteTargets({
        publicModelId: "quota-model",
        endpoint,
      }).find((candidate) => candidate.connectionId === first.id)!
      const attempts: string[] = []
      const app = new Hono()
      app.post(`/v1/${endpoint}`, async (c) => {
        try {
          await executeWithFailover({
            payload: { model },
            admission: {
              target,
              connection: first,
              credential: first.credentials[0],
              ...(mode === "group" && {
                groupMembers: [
                  "network/quota-model:high",
                  "spent/quota-model:low",
                ],
              }),
            },
            routeKind: endpoint,
            execute: (_adapter, selected) => {
              attempts.push(selected.connectionId)
              const isNetwork = selected.connectionId === "network"
              throw new HTTPError(
                "upstream failed",
                new Response(null, {
                  status:
                    isNetwork ? 520
                    : mode === "stream-400" ? 400
                    : 429,
                  headers:
                    mode === "header" && !isNetwork ?
                      { "Retry-After": "8025" }
                    : undefined,
                }),
                isNetwork ?
                  "<html>unavailable</html>"
                : JSON.stringify({
                    error: {
                      type: "usage_limit_reached",
                      resets_in_seconds: 8025,
                    },
                  }),
              )
            },
          })
          return c.text("unexpected success")
        } catch (error) {
          return forwardError(c, error)
        }
      })
      const response = await app.request(`/v1/${endpoint}`, { method: "POST" })
      expect(attempts).toEqual(
        mode === "pinned" ? ["spent"] : ["network", "spent"],
      )
      expect(response.status).toBe(429)
      const seconds = Number(response.headers.get("Retry-After"))
      if (mode === "pinned") {
        expect(seconds).toBe(8025)
      } else {
        expect(seconds).toBeGreaterThan(55)
        expect(seconds).toBeLessThanOrEqual(60)
      }
      expect(Number(response.headers.get("retry-after-ms"))).toBe(
        seconds * 1000,
      )
      expect(Number(response.headers.get("x-ratelimit-reset"))).toBe(seconds)
      const body = (await response.json()) as {
        type?: string
        error: { type: string }
      }
      expect(body.error.type).toBe(
        endpoint === "messages" ? "rate_limit_error" : "rate_limit_exceeded",
      )
      if (endpoint === "messages") expect(body.type).toBe("error")
    },
  )
})
