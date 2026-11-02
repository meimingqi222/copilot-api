import { expect, test } from "bun:test"

import { getPublicModelData } from "~/lib/model-catalog"
import type { Model } from "~/lib/model-catalog"

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
