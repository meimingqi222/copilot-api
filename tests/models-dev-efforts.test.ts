import { afterEach, describe, expect, test } from "bun:test"

import type { ModelsDevCatalog } from "~/lib/models-dev"

import {
  resolveModelsDevEfforts,
  setModelsDevCatalogForTest,
} from "~/lib/models-dev"
import { clampEffortForModel, effortsForModel } from "~/lib/reasoning-effort"
import { state } from "~/lib/state"

/**
 * Two providers agree on deepseek-v4.1-flash (low/high/max), one lists a
 * narrower set — the consensus must be the two-provider set, as magpie's
 * `mostListed` picks.
 */
const CATALOG: ModelsDevCatalog = {
  cortecs: {
    id: "cortecs",
    models: {
      "deepseek-v4.1-flash": {
        id: "deepseek-v4.1-flash",
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
        ],
      },
      "tie-model": {
        id: "tie-model",
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      },
      "claude-x": {
        id: "claude-x",
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      },
    },
  },
  opencode: {
    id: "opencode",
    models: {
      "deepseek-v4.1-flash": {
        id: "deepseek-v4.1-flash",
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
    },
  },
  requesty: {
    id: "requesty",
    models: {
      "deepseek-v4.1-flash": {
        id: "deepseek-v4.1-flash",
        reasoning_options: [
          { type: "effort", values: ["none", "low", "medium", "high", "max"] },
        ],
      },
      "tie-model": {
        id: "tie-model",
        reasoning_options: [{ type: "effort", values: ["low", "medium"] }],
      },
    },
  },
  anthropic: {
    id: "anthropic",
    models: {
      "claude-x": {
        id: "claude-x",
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
      "gpt-sol-v2": {
        id: "gpt-sol-v2",
        capabilities: {
          reasoning: {
            supported: true,
            effort: ["low", "medium", "default", "high"],
          },
        },
      },
    },
  },
  zai: {
    id: "zai",
    models: {
      "glm-5.3": {
        id: "glm-5.3",
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
    },
  },
}

const originalModels = state.models

afterEach(() => {
  setModelsDevCatalogForTest(null)
  state.models = originalModels
})

describe("models.dev reasoning levels", () => {
  test("uses the level set most providers agree on", () => {
    setModelsDevCatalogForTest(CATALOG)
    // 两家 low/high/max，一家 low/medium/high，一家带 none 的 five-way。
    expect(resolveModelsDevEfforts("deepseek-v4.1-flash")).toEqual([
      "low",
      "high",
      "max",
    ])
  })

  test("breaks a tie towards fewer levels, then lexicographically", () => {
    setModelsDevCatalogForTest(CATALOG)
    // 1:1，取更短的一组（两组一样长，取字典序靠前）。
    expect(resolveModelsDevEfforts("tie-model")).toEqual(["low", "high"])
  })

  test("reads v2 capabilities.reasoning and drops its default spelling", () => {
    setModelsDevCatalogForTest(CATALOG)
    expect(resolveModelsDevEfforts("gpt-sol-v2")).toEqual([
      "low",
      "medium",
      "high",
    ])
  })

  test("prefers the provider's own entry when one is hinted", () => {
    setModelsDevCatalogForTest(CATALOG)
    expect(resolveModelsDevEfforts("claude-x", "claude")).toEqual([
      "low",
      "high",
      "max",
    ])
    // 无提示时两者各一票，取更短的一组。
    expect(resolveModelsDevEfforts("claude-x")).toEqual(["low", "high"])
  })

  test("resolves catalog provider references", () => {
    setModelsDevCatalogForTest(CATALOG)
    expect(resolveModelsDevEfforts("zai/glm-5.3")).toEqual([
      "low",
      "high",
      "max",
    ])
  })
})

describe("clamping falls back to models.dev", () => {
  test("clamps a bare endpoint model with no connection-declared levels", () => {
    setModelsDevCatalogForTest(CATALOG)
    state.models = { object: "list", data: [] }

    expect(effortsForModel("deepseek-v4.1-flash")).toEqual([
      "low",
      "high",
      "max",
    ])
    expect(clampEffortForModel("deepseek-v4.1-flash", "max")).toBe("max")
    expect(clampEffortForModel("deepseek-v4.1-flash", "minimal")).toBe("low")
    // Codex 的 ultra 先折成 max。
    expect(clampEffortForModel("deepseek-v4.1-flash", "ultra")).toBe("max")
    // 目录不认识的模型照旧原样转发。
    expect(clampEffortForModel("mystery-model", "max")).toBe("max")
  })

  test("a connection's own levels win over the catalog", () => {
    setModelsDevCatalogForTest(CATALOG)
    state.models = {
      object: "list",
      data: [
        {
          id: "deepseek-v4.1-flash",
          object: "model",
          name: "DeepSeek V4.1 Flash",
          preview: false,
          vendor: "DeepSeek",
          version: "1",
          model_picker_enabled: true,
          capabilities: {
            family: "deepseek",
            object: "capabilities",
            supports: { streaming: true, reasoning_effort: ["high"] },
            tokenizer: "unknown",
            type: "chat",
          },
        },
      ],
    }

    expect(effortsForModel("deepseek-v4.1-flash")).toEqual(["high"])
    expect(clampEffortForModel("deepseek-v4.1-flash", "max")).toBe("high")
  })
})
