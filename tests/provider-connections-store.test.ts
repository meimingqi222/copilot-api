import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  getConnectionRoutability,
  initializeProviderConnections,
  listProviderConnections,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  setConnectionQuotaInfo,
  setConnectionQuotaState,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  loadProviderConnections,
  saveProviderConnections,
} from "~/lib/provider-connections/store"
import { __resetPlanAllowanceMirrorForTest } from "~/lib/plan-quota/apply"
import { resetPlanQuotaStore } from "~/lib/plan-quota/store"
import { refreshManagedQuota } from "~/lib/quota/refresh"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { buildRouteTargets, clearRestRegistryForTest } from "~/lib/route-target"
import { recordRest, restInfoFor } from "~/lib/route-target/rest-registry"
import { initializeProviderRegistry } from "~/services/providers"

initializeProviderRegistry()

function legacyFeatureExhaustion(
  feature: "review" | "additional",
): ProviderConnection {
  const at = Date.now() - 10 * 60_000
  const until = at + 24 * 60 * 60_000
  const featureLimit = { primary_window: { used_percent: 100 } }
  return {
    id: "legacy-codex",
    name: "legacy Codex",
    protocol: "codex-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    weight: 1,
    createdAt: at,
    models: [
      {
        publicId: "gpt-5",
        upstreamId: "gpt-5",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
    credentials: [
      {
        id: "legacy-credential",
        value: "test-token",
        authMode: "bearer",
        enabled: true,
        priority: 0,
        weight: 1,
        createdAt: at,
        status: "quota_exhausted",
        exhaustedAt: at,
        cooldownUntil: until,
        quota: {
          provider: "codex",
          fetchedAt: at,
          unlimited: false,
          premiumInteractionsRemaining: 0,
          details: {
            rate_limit: { primary_window: { used_percent: 25 } },
            ...(feature === "review" ?
              { code_review_rate_limit: featureLimit }
            : {
                additional_rate_limits: [
                  { metered_feature: "spark", rate_limit: featureLimit },
                ],
              }),
          },
        },
      },
    ],
    metadata: {
      provider: "codex",
      quotaState: "exhausted",
      quotaExhaustedAt: at,
      cooldownUntil: until,
    },
  }
}

describe("loadProviderConnections", () => {
  const isolationRoot = PATHS.APP_DIR
  let tempAppDir: string
  let tempPath: string

  beforeEach(async () => {
    tempAppDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `provider-connections-${randomUUID()}-`),
    )
    redirectPathsToDir(tempAppDir)
    tempPath = PATHS.PROVIDER_CONNECTIONS_PATH
    __resetProviderConnectionsForTest()
    resetAdaptiveRateLimiterForTest()
    clearRestRegistryForTest()
    resetPlanQuotaStore()
    __resetPlanAllowanceMirrorForTest()
  })

  afterEach(async () => {
    __resetProviderConnectionsForTest()
    resetAdaptiveRateLimiterForTest()
    clearRestRegistryForTest()
    resetPlanQuotaStore()
    __resetPlanAllowanceMirrorForTest()
    redirectPathsToDir(isolationRoot)
    await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
  })

  test("returns empty array when file is missing", async () => {
    const connections = await loadProviderConnections()
    expect(connections).toEqual([])
  })

  test("throws when recoverable file exists but is corrupt", async () => {
    await fs.writeFile(tempPath, "{ not valid json", "utf8")

    try {
      await loadProviderConnections()
      expect.unreachable("expected corrupt provider-connections load to throw")
    } catch (error) {
      expect((error as Error).message).toMatch(/corrupt or unreadable/i)
    }
  })

  test.each(["review", "additional"] as const)(
    "persisted Codex %s false exhaustion admits routing after a failed 503 refresh",
    async (feature) => {
      const legacy = legacyFeatureExhaustion(feature)
      // A first snapshot may precede application; the additional-meter case
      // retains equality to cover both sides of the repair's time boundary.
      if (feature === "review") legacy.credentials[0]!.quota!.fetchedAt -= 1
      await saveProviderConnections([legacy])
      await initializeProviderConnections()
      const connection = listProviderConnections()[0]!
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("quota temporarily unavailable", { status: 503 }),
      )
      try {
        await expect(refreshManagedQuota(connection)).rejects.toMatchObject({
          response: { status: 503 },
          responseBody: "quota temporarily unavailable",
        })
        expect(getConnectionRoutability(connection).routable).toBe(true)
        expect(
          buildRouteTargets({ publicModelId: "gpt-5", endpoint: "responses" }),
        ).toHaveLength(1)
        expect(
          connection.credentials[0]!.quota?.premiumInteractionsRemaining,
        ).toBe(75)
        expect(connection.credentials[0]!.quota?.fetchedAt).toBe(
          legacy.credentials[0]!.quota!.fetchedAt,
        )
        expect(connection.credentials[0]!.quota?.details).toEqual(
          legacy.credentials[0]!.quota!.details,
        )
        expect(connection.credentials[0]!.cooldownUntil).toBeUndefined()
        // A later save/reload must not reinstate the synthetic wait.
        await saveProviderConnections([connection])
        expect(
          (await loadProviderConnections())[0]!.credentials[0]!.status,
        ).toBe("ready")
      } finally {
        fetch.mockRestore()
      }
    },
  )

  test("delayed feature snapshot cannot erase genuine shared exhaustion on reload", async () => {
    const legacy = legacyFeatureExhaustion("review")
    const credential = legacy.credentials[0]!
    const exhaustedAt = credential.exhaustedAt!
    const realExhaustion = structuredClone(credential.quota!)
    realExhaustion.details!.rate_limit = {
      primary_window: { used_percent: 100 },
    }
    setConnectionQuotaInfo(legacy, realExhaustion)
    setConnectionQuotaState(legacy, "exhausted")

    // A slower pre-upgrade query finishes one millisecond later. Its payload
    // predates real depletion, but the old parser also aggregates it to zero.
    const delayed = structuredClone(realExhaustion)
    delayed.fetchedAt = exhaustedAt + 1
    delayed.details!.rate_limit = { primary_window: { used_percent: 99 } }
    setConnectionQuotaInfo(legacy, delayed)
    setConnectionQuotaState(legacy, "exhausted")
    expect(credential.exhaustedAt).toBe(exhaustedAt)
    expect(credential.cooldownUntil).toBe(exhaustedAt + 24 * 60 * 60_000)

    await saveProviderConnections([legacy])
    await initializeProviderConnections()
    const connection = listProviderConnections()[0]!
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("quota temporarily unavailable", { status: 503 }),
    )
    try {
      await expect(refreshManagedQuota(connection)).rejects.toMatchObject({
        response: { status: 503 },
        responseBody: "quota temporarily unavailable",
      })
      expect(getConnectionRoutability(connection).routable).toBe(false)
      expect(
        buildRouteTargets({ publicModelId: "gpt-5", endpoint: "responses" }),
      ).toHaveLength(0)
      expect(connection.credentials[0]).toEqual(credential)
      expect(connection.metadata).toEqual(legacy.metadata)
    } finally {
      fetch.mockRestore()
    }
  })

  test.each([
    "shared",
    "shared-secondary",
    "auth",
    "metadata-auth",
    "disabled-connection",
    "disabled-credential",
    "upstream-error",
    "upstream-rate",
    "upstream-cooldown",
    "independent-wait",
    "missing-raw",
    "shared-denied",
    "shared-limit-reached",
    "malformed-shared",
    "no-exhausted-feature",
  ] as const)(
    "persisted Codex repair preserves %s admission guard",
    async (guard) => {
      const legacy = legacyFeatureExhaustion("review")
      const credential = legacy.credentials[0]!
      const details = credential.quota!.details!
      if (guard === "shared")
        details.rate_limit = { primary_window: { used_percent: 100 } }
      if (guard === "shared-secondary")
        details.rate_limit = {
          primary_window: { used_percent: 25 },
          secondary_window: { used_percent: 100 },
        }
      if (guard === "auth") credential.status = "auth_error"
      if (guard === "metadata-auth") legacy.metadata!.authStatus = "error"
      if (guard === "disabled-connection") legacy.enabled = false
      if (guard === "disabled-credential") credential.enabled = false
      if (guard === "upstream-error") {
        markCredentialQuotaExhausted(
          credential,
          "usage_limit_reached",
          24 * 60 * 60_000,
          credential.exhaustedAt,
        )
      }
      if (guard === "upstream-rate")
        credential.lastRateLimitAt = credential.exhaustedAt
      if (guard === "upstream-cooldown")
        markCredentialCooldown(credential, {
          retryAfterMs: 60 * 60_000,
          reason: "upstream 429",
        })
      if (guard === "independent-wait") credential.cooldownUntil! -= 60_000
      if (guard === "missing-raw") delete details.rate_limit
      if (guard === "shared-denied")
        details.rate_limit = {
          allowed: false,
          primary_window: { used_percent: 25 },
        }
      if (guard === "shared-limit-reached")
        details.rate_limit = {
          limit_reached: true,
          primary_window: { used_percent: 25 },
        }
      if (guard === "malformed-shared")
        details.rate_limit = {
          primary_window: { used_percent: 25 },
          secondary_window: { used_percent: "invalid" },
        }
      if (guard === "no-exhausted-feature")
        delete details.code_review_rate_limit
      await saveProviderConnections([legacy])
      await initializeProviderConnections()
      const connection = listProviderConnections()[0]!
      const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("quota temporarily unavailable", { status: 503 }),
      )
      try {
        await expect(refreshManagedQuota(connection)).rejects.toMatchObject({
          response: { status: 503 },
          responseBody: "quota temporarily unavailable",
        })
        expect(getConnectionRoutability(connection).routable).toBe(false)
        expect(
          buildRouteTargets({ publicModelId: "gpt-5", endpoint: "responses" }),
        ).toHaveLength(0)
        expect(connection.credentials[0]).toEqual(credential)
        expect(connection.metadata).toEqual(legacy.metadata)
      } finally {
        fetch.mockRestore()
      }
    },
  )

  test("v1 Codex snapshots with camelCase meters repair without inventing freshness", async () => {
    const legacy = legacyFeatureExhaustion("additional")
    const credential = legacy.credentials[0]!
    const snapshot = credential.quota!
    snapshot.details = {
      rateLimit: {
        primaryWindow: { usedPercent: "25" },
        secondaryWindow: { usedPercent: "50" },
      },
      additionalRateLimits: [
        { rateLimit: { primaryWindow: { usedPercent: "100" } } },
      ],
    }
    legacy.metadata!.quotaInfo = snapshot
    credential.quota = undefined
    await fs.writeFile(
      tempPath,
      JSON.stringify({ version: 1, connections: [legacy] }),
    )
    const [connection] = await loadProviderConnections()
    expect(
      connection!.credentials[0]!.quota?.premiumInteractionsRemaining,
    ).toBe(50)
    expect(connection!.credentials[0]!.quota?.fetchedAt).toBe(
      snapshot.fetchedAt,
    )
    expect(connection!.credentials[0]!.status).toBe("ready")
  })

  test("persisted Codex repair never lifts an independent live rest", async () => {
    const legacy = legacyFeatureExhaustion("review")
    const credential = legacy.credentials[0]!
    const rest = recordRest({
      credentialId: credential.id,
      credentialCreatedAt: credential.createdAt,
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + 60_000,
    })
    await saveProviderConnections([legacy])
    await initializeProviderConnections()
    expect(listProviderConnections()[0]!.credentials[0]!.status).toBe("ready")
    expect(restInfoFor(credential.id)?.untilMs).toBe(rest.untilMs)
    expect(restInfoFor(credential.id)?.reason).toBe("rate")
    expect(
      buildRouteTargets({ publicModelId: "gpt-5", endpoint: "responses" }),
    ).toHaveLength(0)
  })
})
