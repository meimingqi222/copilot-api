import { afterEach, beforeEach, expect, test } from "bun:test"

import { getPublicModelData } from "~/lib/model-catalog"
import type { Model } from "~/lib/model-catalog"
import {
  getModelsDevCatalog,
  setModelsDevCatalogForTest,
} from "~/lib/models-dev"
import {
  __resetProviderConnectionsForTest,
  managedConnectionFromInput,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

const originalCatalog = getModelsDevCatalog()
const originalModels = state.models

beforeEach(() => {
  __resetProviderConnectionsForTest()
  setModelsDevCatalogForTest({
    deepseek: {
      id: "deepseek",
      models: {
        "deepseek-v4.1-flash": {
          id: "deepseek-v4.1-flash",
          limit: { context: 1_000_000 },
        },
      },
    },
    openai: {
      id: "openai",
      models: {
        "gpt-6-astra": {
          id: "gpt-6-astra",
          limit: { context: 900_000 },
        },
      },
    },
  })
})

afterEach(() => {
  __resetProviderConnectionsForTest()
  state.models = originalModels
  setModelsDevCatalogForTest(originalCatalog)
})

const base: Model = {
  capabilities: {
    family: "codex",
    limits: {
      max_context_window_tokens: 400_000,
      max_output_tokens: 128_000,
      max_prompt_tokens: 272_000,
    },
    object: "model_capabilities",
    supports: {
      streaming: true,
      reasoning_effort: ["low", "medium", "high", "xhigh"],
    },
    tokenizer: "o200k_base",
    type: "model",
  },
  id: "gpt-6-astra",
  model_picker_enabled: true,
  name: "GPT-6 Astra",
  object: "model",
  preview: true,
  vendor: "openai",
  version: "gpt-6-astra",
}

test("public model rows flatten discovery fields omp's /v1/models reader consumes", () => {
  const row = getPublicModelData(base)
  expect(row.supported_reasoning_levels).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
  ])
  expect(row.default_reasoning_level).toBe("low")
  expect(row.reasoning).toBe(true)
  expect(row.context_length).toBe(400_000)
  expect(row.limits).toEqual({
    max_input_tokens: 272_000,
    max_output_tokens: 128_000,
  })
  expect(row.display_name).toBe("GPT-6 Astra")
})

test("declared effort order is normalized ascending for the public default", () => {
  const row = getPublicModelData({
    ...base,
    capabilities: {
      ...base.capabilities,
      supports: {
        streaming: true,
        reasoning_effort: ["high", "custom-effort", "low", "medium"],
      },
    },
  })
  expect(row.supported_reasoning_levels).toEqual([
    "low",
    "medium",
    "high",
    "custom-effort",
  ])
  expect(row.default_reasoning_level).toBe("low")
  // capabilities 内部目录保持声明原序,只有对外投影排序。
  expect(row.capabilities.supports.reasoning_effort).toEqual([
    "high",
    "custom-effort",
    "low",
    "medium",
  ])
})

test("models without declared efforts or limits omit the flattened fields", () => {
  const row = getPublicModelData({
    ...base,
    id: "unknown-model",
    capabilities: {
      ...base.capabilities,
      limits: undefined,
      supports: { streaming: true },
    },
  })
  expect(row.supported_reasoning_levels).toBeUndefined()
  expect(row.default_reasoning_level).toBeUndefined()
  expect(row.reasoning).toBeUndefined()
  expect(row.context_length).toBeUndefined()
  expect(row.limits).toBeUndefined()
})

test("public model context falls back to the catalog without mutating upstream metadata", () => {
  const model: Model = {
    ...base,
    id: "deepseek-v4.1-flash",
    capabilities: {
      ...base.capabilities,
      family: "codebuddy-cn",
      limits: { max_output_tokens: 64_000 },
    },
  }
  const row = getPublicModelData(model)
  expect(row.context_length).toBe(1_000_000)
  expect(row.capabilities.limits).toEqual({
    max_context_window_tokens: 1_000_000,
    max_output_tokens: 64_000,
  })
  expect(row.limits).toEqual({ max_output_tokens: 64_000 })
  expect(model.capabilities.limits).toEqual({ max_output_tokens: 64_000 })
  expect(
    getPublicModelData({ ...model, vendor: "routing-group" }).context_length,
  ).toBeUndefined()
})

test("public discovery retains native default windows and input-only limits conservatively", () => {
  const first = managedConnectionFromInput({
    id: "native-limits-first",
    name: "Native limits",
    provider: "trae-cn",
    enabled: true,
    credentials: { accessToken: "test-token" },
  })
  first.models = [
    {
      publicId: "shared-window",
      upstreamId: "shared-window",
      endpoints: ["chat"],
      enabled: true,
      metadata: {
        contextWindow: 272_000,
        maxContextWindow: 872_000,
        contextWindows: [272_000, 500_000, 872_000],
        outputLimit: 64_000,
      },
    },
    {
      publicId: "deepseek-v4.1-flash",
      upstreamId: "deepseek-v4.1-flash",
      endpoints: ["chat"],
      enabled: true,
      metadata: { inputLimit: 96_000, outputLimit: 32_000 },
    },
  ]
  const second = managedConnectionFromInput({
    id: "native-limits-second",
    name: "Lower limits",
    provider: "trae-cn",
    enabled: true,
    credentials: { accessToken: "test-token" },
  })
  second.models = [
    {
      ...first.models[0]!,
      metadata: {
        contextWindow: 200_000,
        maxContextWindow: 500_000,
        contextWindows: [200_000, 500_000],
        outputLimit: 32_000,
      },
    },
  ]
  const qoder = managedConnectionFromInput({
    id: "qoder-input-limits",
    name: "Qoder",
    provider: "qoder-cn",
    enabled: true,
    credentials: { accessToken: "test-token" },
  })
  qoder.models = [
    {
      publicId: "ultimate",
      upstreamId: "ultimate",
      endpoints: ["chat"],
      enabled: true,
      metadata: { contextWindow: 1_000_000 },
    },
  ]
  for (const connection of [first, second, qoder])
    upsertProviderConnection(connection)
  cacheModels()
  const rows = new Map(
    state.models!.data.map((model) => [model.id, getPublicModelData(model)]),
  )
  expect(rows.get("shared-window")).toMatchObject({
    context_length: 200_000,
    max_context_length: 500_000,
    supported_context_lengths: [500_000],
    limits: { max_output_tokens: 32_000 },
  })
  expect(rows.get("deepseek-v4.1-flash")?.context_length).toBeUndefined()
  expect(rows.get("deepseek-v4.1-flash")?.limits).toEqual({
    max_input_tokens: 96_000,
    max_output_tokens: 32_000,
  })
  expect(rows.get("ultimate")?.context_length).toBeUndefined()
  expect(rows.get("ultimate")?.limits).toEqual({
    max_input_tokens: 1_000_000,
  })
})
