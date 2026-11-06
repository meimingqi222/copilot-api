import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  createConnection,
  removeProviderConnection,
  upsertProviderConnection,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import type { ProviderQuotaSnapshot } from "~/lib/quota/types"
import * as copilotQuota from "~/lib/quota/fetchers/copilot"
import { refreshProviderQuota } from "~/lib/quota/refresh"
import { refreshQuotaForConnection } from "~/lib/quota/scheduler"
import { onStateChange } from "~/lib/state-events"
import { createOAuthProviderRuntime } from "~/services/providers/oauth"

beforeEach(() => __resetProviderConnectionsForTest())
afterEach(() => __resetProviderConnectionsForTest())

test("provider-owned operations update connection models and quota without central dispatch", async () => {
  const connection = await createConnection({
    id: "module-operations",
    name: "module operations",
    protocol: "codex-native",
    baseUrl: "https://example.test",
    credentials: [
      { id: "module-credential", value: "test", authMode: "bearer" },
    ],
  })
  const models: Array<ModelMapping> = [
    {
      publicId: "module-model",
      upstreamId: "upstream-model",
      enabled: true,
      endpoints: ["responses"],
    },
  ]
  const signal = new AbortController().signal
  const snapshot: ProviderQuotaSnapshot = {
    fetchedAt: Date.now(),
    unlimited: false,
    premiumInteractionsRemaining: 80,
    allowance: { state: "unknown", windows: [] },
  }
  const runtime = createOAuthProviderRuntime("codex", {
    async discoverModels(received) {
      expect(received).toBe(connection)
      return models
    },
    getFallbackModels(received) {
      expect(received).toBe(connection)
      return models
    },
    async fetchQuota(received, receivedSignal) {
      expect(received).toBe(connection)
      expect(receivedSignal).toBe(signal)
      return snapshot
    },
  })
  expect(await runtime.refreshModels(connection)).toEqual(models)
  expect(connection.models).toEqual(models)
  expect(runtime.getFallbackModels?.(connection)).toEqual(models)
  expect(await runtime.refreshQuota?.(connection, signal)).toBe(snapshot)
  expect(connection.credentials[0]?.quota).toBe(snapshot)
})

test("provider-owned operations never run for another provider's connection", async () => {
  const connection = await createConnection({
    id: "other-module-operations",
    name: "other provider",
    protocol: "claude-native",
    baseUrl: "https://example.test",
    credentials: [],
  })
  const unexpected = () => {
    throw new Error("wrong provider operation")
  }
  const runtime = createOAuthProviderRuntime("codex", {
    discoverModels: unexpected,
    getFallbackModels: unexpected,
    fetchQuota: unexpected,
  })
  expect(await runtime.refreshModels(connection)).toEqual([])
  expect(runtime.getFallbackModels?.(connection)).toEqual([])
  expect(await runtime.refreshQuota?.(connection)).toBeUndefined()
})

test.each([false, true])(
  "Copilot compatibility refresh delegates once and preserves skipSave=%s",
  async (skipSave) => {
    const connection = await createConnection({
      id: "copilot-compatibility",
      name: "copilot quota",
      protocol: "copilot-native",
      baseUrl: "https://example.test",
      credentials: [
        { id: "copilot-credential", value: "test", authMode: "bearer" },
      ],
    })
    const snapshot: ProviderQuotaSnapshot = {
      fetchedAt: Date.now(),
      unlimited: false,
      allowance: {
        state: "known",
        windows: [
          { id: "premium", remaining: 20, total: 100, unit: "requests" },
        ],
      },
    }
    const fetchQuota = spyOn(
      copilotQuota,
      "fetchCopilotQuota",
    ).mockResolvedValue(snapshot)
    let changes = 0
    const unsubscribe = onStateChange("models-stale", () => {
      changes++
    })
    try {
      expect(await refreshQuotaForConnection(connection, skipSave)).toBe(
        snapshot,
      )
      expect(fetchQuota).toHaveBeenCalledTimes(1)
      expect(connection.credentials.at(0)?.quota).toBe(snapshot)
      expect(changes).toBe(skipSave ? 0 : 1)
    } finally {
      fetchQuota.mockRestore()
      unsubscribe()
    }
  },
)

const staleRefreshCases: Array<
  [string, (connection: ProviderConnection) => void]
> = [
  [
    "deleted connection",
    (connection) => {
      removeProviderConnection(connection.id)
    },
  ],
  [
    "replaced connection",
    (connection) => {
      upsertProviderConnection(structuredClone(connection))
    },
  ],
  [
    "disabled connection",
    (connection) => {
      connection.enabled = false
    },
  ],
  [
    "disabled credential",
    (connection) => {
      connection.credentials.at(0)!.enabled = false
    },
  ],
  [
    "replaced credential",
    (connection) => {
      connection.credentials[0] = structuredClone(connection.credentials.at(0)!)
    },
  ],
  [
    "rotated access token",
    (connection) => {
      connection.credentials.at(0)!.value = "rotated"
    },
  ],
  [
    "rotated refresh context",
    (connection) => {
      connection.credentials.at(0)!.context = { refreshToken: "rotated" }
    },
  ],
  [
    "newer response observation",
    (connection) => {
      connection.credentials.at(0)!.quota = {
        fetchedAt: Date.now() + 1,
        unlimited: true,
      }
    },
  ],
]

for (const [reason, mutate] of staleRefreshCases) {
  test(`quota refresh discards a result after ${reason}`, async () => {
    const connection = await createConnection({
      id: "stale-quota",
      name: "stale quota",
      protocol: "codex-native",
      baseUrl: "https://example.test",
      credentials: [
        { id: "stale-credential", value: "test", authMode: "bearer" },
      ],
    })
    const pending = Promise.withResolvers<ProviderQuotaSnapshot>()
    const runtime = createOAuthProviderRuntime("codex", {
      fetchQuota: () => pending.promise,
    })
    const refreshing = runtime.refreshQuota!(connection)
    mutate(connection)
    const retained = connection.credentials.at(0)?.quota
    pending.resolve({
      fetchedAt: Date.now() + 2,
      unlimited: false,
      chatRemaining: 0,
      allowance: { state: "known", windows: [{ id: "w", remaining: 0 }] },
    })
    expect(await refreshing).toBeUndefined()
    expect(connection.credentials.at(0)?.quota).toBe(retained)
    expect(connection.credentials.at(0)?.status).toBe("ready")
  })
}

test("a provider renewing its own token before the poll keeps the reading", async () => {
  const connection = await createConnection({
    id: "renewing-quota",
    name: "renewing quota",
    protocol: "codex-native",
    baseUrl: "https://example.test",
    credentials: [
      { id: "renewing-credential", value: "expired", authMode: "bearer" },
    ],
  })
  const snapshot: ProviderQuotaSnapshot = {
    fetchedAt: Date.now() + 1,
    unlimited: false,
    allowance: { state: "known", windows: [{ id: "w", used: 0.2 }] },
  }
  const applied = await refreshProviderQuota(
    connection,
    async () => snapshot,
    undefined,
    {
      skipSave: true,
      async prepare(conn) {
        // What CodeBuddy's and LobsterAI's access-token renewal does.
        conn.credentials[0]!.value = "renewed"
        conn.credentials[0]!.context = { refreshToken: "next" }
      },
    },
  )
  expect(applied).toBe(snapshot)
  expect(connection.credentials.at(0)?.quota).toBe(snapshot)
})
