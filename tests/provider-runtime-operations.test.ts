import { afterEach, beforeEach, expect, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  createConnection,
  type ModelMapping,
} from "~/lib/provider-connections"
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
  const snapshot = {
    fetchedAt: Date.now(),
    unlimited: false,
    premiumInteractionsRemaining: 80,
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
