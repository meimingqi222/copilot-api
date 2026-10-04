import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import * as connectionStore from "~/lib/provider-connections/store"
import { onStateChange } from "~/lib/state-events"

import {
  __resetProviderConnectionsForTest,
  createConnection,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { applyOAuthQuotaSnapshot } from "~/lib/quota"
import { refreshManagedQuota } from "~/lib/quota/refresh"
import { refreshAllQuotas } from "~/lib/quota/scheduler"
import { routeEvidenceFor } from "~/lib/route-target/evidence"
import { initializeProviderRegistry } from "~/services/providers"
import {
  getProviderRuntime,
  registerProvider,
} from "~/services/providers/registry"

initializeProviderRegistry()
const originalCodex = getProviderRuntime("codex")
const originalClaude = getProviderRuntime("claude")
let reads = 0
let fail = false

beforeEach(() => {
  __resetProviderConnectionsForTest()
  reads = 0
  fail = false
  for (const original of [originalCodex, originalClaude]) {
    registerProvider({
      ...original,
      async refreshQuota(connection, signal) {
        expect(signal).toBeInstanceOf(AbortSignal)
        reads++
        if (fail) throw new Error("quota unavailable")
        const snapshot = {
          fetchedAt: Date.now(),
          unlimited: false,
          premiumInteractionsRemaining: 75,
          premiumInteractionsTotal: 100,
        }
        applyOAuthQuotaSnapshot(connection, snapshot)
        return snapshot
      },
    })
  }
})

afterEach(() => {
  registerProvider(originalCodex)
  registerProvider(originalClaude)
  __resetProviderConnectionsForTest()
})

async function account(
  protocol: "codex-native" | "claude-native" = "codex-native",
  id = `quota-${protocol}`,
): Promise<ProviderConnection> {
  return createConnection({
    id,
    name: "quota refresh",
    protocol,
    baseUrl: "https://example.test",
    credentials: [
      { id: "quota-credential", value: "test", authMode: "bearer" },
    ],
  })
}

test("background refresh includes healthy OAuth accounts and skips disabled accounts", async () => {
  const connection = await account()
  await refreshAllQuotas()
  expect(reads).toBe(1)
  expect(
    routeEvidenceFor(connection.id, "quota-credential").quota?.usedFraction,
  ).toBe(0.25)
  expect(connection.credentials[0]?.quota?.premiumInteractionsRemaining).toBe(
    75,
  )
  await refreshAllQuotas()
  expect(reads).toBe(1)
  connection.enabled = false
  connection.credentials[0]!.quota = undefined
  await refreshAllQuotas()
  expect(reads).toBe(1)
  connection.enabled = true
  connection.credentials[0]!.enabled = false
  await refreshAllQuotas()
  expect(reads).toBe(1)
})

test("exhausted accounts are still probed and recover through the provider runtime", async () => {
  const connection = await account()
  connection.credentials[0]!.status = "quota_exhausted"
  await refreshAllQuotas()
  expect(reads).toBe(1)
  expect(String(connection.credentials[0]!.status)).toBe("ready")
})

test("refresh merges simultaneous manual and background reads and throttles repeats", async () => {
  const connection = await account()
  const first = refreshManagedQuota(connection)
  expect(refreshManagedQuota(connection, { force: true })).toBe(first)
  await first
  const now = Date.now()
  await refreshManagedQuota(connection, { now: now + 29_000, force: true })
  expect(reads).toBe(1)
  await refreshManagedQuota(connection, { now: now + 31_000, force: true })
  expect(reads).toBe(2)
  await refreshManagedQuota(connection, { now: now + 32_000 })
  expect(reads).toBe(2)
  await refreshManagedQuota(connection, { now: now + 332_000 })
  expect(reads).toBe(3)
})

test("Claude background polling uses a longer interval", async () => {
  const connection = await account("claude-native")
  await refreshManagedQuota(connection)
  const now = Date.now()
  await refreshManagedQuota(connection, { now: now + 5 * 60_000 })
  expect(reads).toBe(1)
  await refreshManagedQuota(connection, { now: now + 15 * 60_000 })
  expect(reads).toBe(2)
})

test("quiet refresh does not persist or notify, but credential context changes do", async () => {
  const conn = await account()
  const persist = spyOn(
    connectionStore,
    "saveProviderConnections",
  ).mockResolvedValue(undefined)
  let events = 0
  const unsubscribe = onStateChange("models-stale", () => {
    events++
  })
  registerProvider({
    ...originalCodex,
    async refreshQuota(connection) {
      // No quota timestamp changes: token-refresh context must still be persisted.
      connection.credentials[0]!.context = { refreshToken: "new-token" }
      connection.credentials[0]!.exhaustedAt = 123
      return undefined
    },
  })
  try {
    await refreshAllQuotas()
    expect(conn.credentials[0]!.context?.refreshToken).toBe("new-token")
    expect(persist).toHaveBeenCalledTimes(1)
    expect(events).toBe(1)
    await refreshAllQuotas()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(events).toBe(1)
  } finally {
    persist.mockRestore()
    unsubscribe()
  }
})

test("a slow quota connection never holds up the next queued connection", async () => {
  for (let i = 0; i < 6; i++) await account("codex-native", `pool-${i}`)
  let release!: () => void
  let reached!: () => void
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  const next = new Promise<void>((resolve) => {
    reached = resolve
  })
  let active = 0
  let peak = 0
  const started: string[] = []
  registerProvider({
    ...originalCodex,
    async refreshQuota(connection) {
      active++
      peak = Math.max(peak, active)
      started.push(connection.id)
      if (connection.id === "pool-0") await slow
      if (connection.id === "pool-5") reached()
      active--
      return undefined
    },
  })
  const running = refreshAllQuotas()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      next,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("batch blocked")), 500)
      }),
    ])
    expect(started).toHaveLength(6)
    expect(peak).toBeLessThanOrEqual(4)
  } finally {
    clearTimeout(timer)
    release()
    await running
  }
})

test("failed refresh keeps the last snapshot and does not retry every scheduler tick", async () => {
  const connection = await account()
  await refreshManagedQuota(connection)
  const previous = connection.credentials[0]?.quota
  fail = true
  const now = Date.now() + 5 * 60_000
  await expect(refreshManagedQuota(connection, { now })).rejects.toThrow(
    "quota unavailable",
  )
  expect(connection.credentials[0]?.quota).toBe(previous)
  await refreshManagedQuota(connection, { now: now + 60_000 })
  expect(reads).toBe(2)
})
