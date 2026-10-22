import { afterEach, expect, spyOn, test } from "bun:test"
import {
  __resetProviderConnectionsForTest,
  setConnectionQuotaState,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  buildRouteTargets,
  clearRestRegistryForTest,
  recordRest,
  selectRouteTarget,
} from "~/lib/route-target"
import { describeCandidates } from "~/lib/route-diagnostics"
import { setTestConnections } from "./helpers/set-connections"

afterEach(() => {
  clearRestRegistryForTest()
  __resetProviderConnectionsForTest()
  setTestConnections([])
})

function fixture() {
  const now = Date.now()
  const connection: ProviderConnection = {
    id: "fixture",
    name: "Synthetic",
    protocol: "codebuddy-native",
    baseUrl: "https://example.test",
    enabled: true,
    priority: 0,
    createdAt: now,
    metadata: { provider: "codebuddy" },
    credentials: [
      {
        id: "fixture-cred",
        authMode: "bearer",
        value: "test",
        enabled: true,
        status: "ready",
        createdAt: now,
      },
    ],
    models: [0, 1].map((price) => ({
      upstreamId: `model-${price}`,
      publicId: `model-${price}`,
      enabled: true,
      endpoints: ["chat"],
      metadata: { codebuddyCredits: price },
    })),
  }
  setConnectionQuotaState(connection, "exhausted")
  setTestConnections([connection])
  return connection
}

function candidates(connection: ProviderConnection) {
  return buildRouteTargets({
    connectionId: connection.id,
    endpoint: "chat",
    onlyAvailable: false,
  })
}

test("free model trace agrees with routing for chosen and backup candidates", () => {
  const connection = fixture()
  recordRest({
    credentialId: "fixture-cred",
    reason: "credit",
    by: "credit",
    untilMs: Date.now() + 60000,
  })
  const available = buildRouteTargets({
    connectionId: connection.id,
    endpoint: "chat",
  })
  expect(available.map((c) => c.upstreamModelId)).toEqual(["model-0"])
  const all = candidates(connection)
  for (const chosen of [
    available[0],
    { ...available[0], connectionId: "elsewhere" },
  ]) {
    const rows = describeCandidates(all, chosen)
    const free = rows.find((r) => r.model === "model-0")!
    expect(free.status).toBe(
      chosen.connectionId === connection.id ? "chosen" : "available",
    )
    expect(free.restUntilMs).toBeUndefined()
    expect(free.retryAfterMs).toBeUndefined()
    expect(free.restReason).toBeUndefined()
    expect(rows.find((r) => r.model === "model-1")!.status).toBe("quota")
  }
})

test("free model trace retains model-specific credit refusal", () => {
  const connection = fixture()
  const all = candidates(connection)
  const untilMs = Date.now() + 60000
  recordRest({
    credentialId: "fixture-cred",
    model: "model-0",
    reason: "credit",
    by: "credit",
    untilMs,
  })
  const row = describeCandidates(all, {
    ...all[0],
    connectionId: "elsewhere",
  }).find((r) => r.model === "model-0")!
  expect(row.restUntilMs).toBe(untilMs)
  expect(row.restReason).toBe("credit")
  expect(row.status).toBe("quota")
})

test("repeated exhausted refresh preserves deadline until recovery", () => {
  const now = Date.now()
  const connection = fixture()
  const until = connection.credentials[0].cooldownUntil
  const at = connection.credentials[0].exhaustedAt
  const date = spyOn(Date, "now").mockReturnValue(now + 3600000)
  try {
    setConnectionQuotaState(connection, "exhausted")
    expect(connection.credentials[0].cooldownUntil).toBe(until)
    expect(connection.credentials[0].exhaustedAt).toBe(at)
    setConnectionQuotaState(connection, "available")
    setConnectionQuotaState(connection, "exhausted")
    expect(connection.credentials[0].exhaustedAt).toBe(now + 3600000)
    expect(connection.credentials[0].cooldownUntil).toBe(until! + 3600000)
  } finally {
    date.mockRestore()
  }
})

test("smart selection keeps zero-balance free primary ahead of funded backup", () => {
  const connection = fixture()
  connection.credentials[0].quota = {
    fetchedAt: Date.now(),
    unlimited: false,
    chatRemaining: 0,
    chatTotal: 100,
  }
  // Public aliases must not change the upstream model's price exemption.
  connection.models![0].publicId = "renamed-free"
  connection.models![0].metadata = {
    codebuddyCredits: "x0.00",
    codebuddyPromotions: [
      {
        kind: "discount",
        enabled: true,
        schedule: { validUntil: new Date(Date.now() + 3600000).toISOString() },
        discount: { discountedCredits: "0x", factor: 0 },
      },
    ],
  }
  const backup: ProviderConnection = {
    ...connection,
    id: "backup",
    priority: 9,
    protocol: "openai-compatible",
    credentials: [
      {
        ...connection.credentials[0],
        id: "backup-cred",
        status: "ready",
        cooldownUntil: undefined,
        quota: {
          fetchedAt: Date.now(),
          unlimited: false,
          chatRemaining: 100,
          chatTotal: 100,
        },
      },
    ],
    metadata: {},
  }
  setTestConnections([connection, backup])
  const pool = buildRouteTargets({
    publicModelId: "renamed-free",
    endpoint: "chat",
  })
  expect(pool).toHaveLength(2)
  for (const strategy of ["quota", "least-used"] as const) {
    expect(
      selectRouteTarget(pool, { strategy, affinityMode: "off" })?.connectionId,
    ).toBe(connection.id)
  }
})

test("free trace still reports account verification and rate rests", () => {
  const connection = fixture()
  const all = candidates(connection)
  for (const reason of ["verify", "rate", "quota"] as const) {
    clearRestRegistryForTest()
    const untilMs = Date.now() + 60000
    recordRest({
      credentialId: "fixture-cred",
      reason,
      by: "cooldown",
      untilMs,
    })
    expect(
      buildRouteTargets({ connectionId: connection.id, endpoint: "chat" }),
    ).toHaveLength(0)
    const free = describeCandidates(all, {
      ...all[0],
      connectionId: "elsewhere",
    }).find((r) => r.model === "model-0")!
    expect(free.restUntilMs).toBe(untilMs)
    expect(free.status).toBe(
      reason === "verify" ? "auth"
      : reason === "quota" ? "quota"
      : "cooldown",
    )
  }
})
