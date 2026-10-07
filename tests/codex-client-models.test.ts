import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Hono } from "hono"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  managedConnectionFromInput,
  getMutableProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { clearRoutingGroupsCacheForTest } from "~/lib/routing-groups"
import { state } from "~/lib/state"
import { initializeSystemConfig, updateSystemConfig } from "~/lib/system-config"
import { cacheModels } from "~/lib/utils"
import type { User } from "~/lib/users"
import { modelRoutes } from "~/routes/models/route"
import { systemConfigApiRoutes } from "~/routes/admin/api/system-config"
import { getCodexFallbackModels } from "~/services/providers/model-catalogs/codex"
import {
  resetCodexClientModelsForTest,
  rememberCodexClientModels,
} from "~/services/codex/client-models"
import { getCodexModelsForConnection } from "~/services/codex/get-models"

const originalPath = PATHS.APP_DIR
const originalModels = state.models
const originalFetch = globalThis.fetch
let testDir: string

beforeEach(async () => {
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  await fs.mkdir("temp", { recursive: true })
  testDir = await fs.mkdtemp(path.resolve("temp/codex-catalog-"))
  redirectPathsToDir(testDir)
  __resetProviderConnectionsForTest()
  clearRoutingGroupsCacheForTest()
  resetCodexClientModelsForTest()
  const connection = managedConnectionFromInput({
    id: "codex-test",
    name: "Codex",
    provider: "codex",
    enabled: true,
    priority: 0,
    credentials: { accessToken: "test-token" },
  })
  connection.models = getCodexFallbackModels()
  upsertProviderConnection(connection)
  cacheModels()
})

afterEach(async () => {
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  redirectPathsToDir(originalPath)
  __resetProviderConnectionsForTest()
  clearRoutingGroupsCacheForTest()
  state.models = originalModels
  globalThis.fetch = originalFetch
  resetCodexClientModelsForTest()
  await fs.rm(testDir, { recursive: true, force: true })
})

test("custom Codex picker orders visible models ahead of hidden dependencies without changing OpenAI catalogs", async () => {
  updateSystemConfig({
    logLevel: "info",
    requestDump: false,
    memoryVerbose: false,
    performanceDetails: true,
    debugMinutes: 15,
    codexModelIds: ["gpt-5.6-luna", "gpt-5.6-sol", "missing-model"],
  })
  const response = await catalog()
  const visible = response.models!.filter(
    (model) => model.visibility === "list",
  )
  expect(visible.map((model) => model.slug)).toEqual([
    "gpt-5.6-luna",
    "gpt-5.6-sol",
  ])
  expect(visible.map((model) => model.priority)).toEqual([0, 1])
  const reviewer = response.models!.find(
    (model) => model.slug === "codex-auto-review",
  )!
  expect(reviewer.visibility).toBe("hide")
  expect(Number(reviewer.priority)).toBeGreaterThanOrEqual(100)
  expect(visible[1].auto_review_model_override).toBe("codex-auto-review")
  const ordinary = await catalog("")
  expect(ordinary.data!.length).toBeGreaterThan(response.models!.length)
  const restricted = await catalog(undefined, ["gpt-5.6-sol"])
  expect(restricted.models!.map((model) => model.slug)).toEqual(["gpt-5.6-sol"])
  expect(restricted.models![0].auto_review_model_override).toBeNull()
  const app = new Hono().route("/", systemConfigApiRoutes)
  const choices = (await (await app.request("/codex-models")).json()) as {
    models: Array<{ id: string }>
  }
  expect(choices.models.length).toBeGreaterThan(visible.length)
  expect(choices.models.some((model) => model.id === "codex-auto-review")).toBe(
    false,
  )
})

test("an empty custom picker keeps only hidden models and null restores the full catalog", async () => {
  const settings = {
    logLevel: "info",
    requestDump: false,
    memoryVerbose: false,
    performanceDetails: true,
    debugMinutes: 15,
  } as const
  updateSystemConfig({ ...settings, codexModelIds: [] })
  expect(
    (await catalog()).models!.every((model) => model.visibility === "hide"),
  ).toBe(true)
  updateSystemConfig({ ...settings, codexModelIds: null })
  expect(
    (await catalog()).models!.some((model) => model.visibility === "list"),
  ).toBe(true)
})

test("all 100 selected models fit in the first Codex page when hidden models are included", async () => {
  const template = state.models!.data.find(
    (model) => model.id === "gpt-5.6-sol",
  )!
  state.models!.data.push(
    ...Array.from({ length: 105 }, (_, index) => ({
      ...template,
      id: `external-${index}`,
      name: `External ${index}`,
      model_picker_enabled: true,
    })),
  )
  const ids = Array.from(
    { length: 100 },
    (_, index) => `external-${104 - index}`,
  )
  updateSystemConfig({
    logLevel: "info",
    requestDump: false,
    memoryVerbose: false,
    performanceDetails: true,
    debugMinutes: 15,
    codexModelIds: ids,
  })
  const response = await catalog()
  const sorted = [...response.models!].sort(
    (left, right) => Number(left.priority) - Number(right.priority),
  )
  expect(sorted.slice(0, 100).map((model) => model.slug)).toEqual(ids)
  expect(
    sorted.slice(100).some((model) => model.slug === "codex-auto-review"),
  ).toBe(true)
  expect(response.models!.some((model) => model.slug === "external-0")).toBe(
    false,
  )
  expect(
    (await catalog("", ["external-0"])).data!.map((model) => model.id),
  ).toEqual(["external-0"])
})

async function catalog(
  query = "?client_version=0.159.0",
  allowedModels?: Array<string>,
) {
  const app = new Hono()
  if (allowedModels) {
    const user: User = {
      id: "catalog-user",
      username: "catalog-user",
      hashedApiKey: "test",
      quotaLimit: 0,
      usedTokens: 0,
      enabled: true,
      role: "user",
      createdAt: 0,
      allowedModels,
    }
    app.use("*", async (c, next) => {
      c.set("user" as never, user as never)
      await next()
    })
  }
  app.route("/models", modelRoutes)
  const response = await app.request(`/models${query}`)
  expect(response.status).toBe(200)
  return (await response.json()) as {
    object?: string
    data?: Array<{ id: string }>
    models?: Array<Record<string, unknown>>
  }
}

test("Codex clients receive a native catalog including the hidden reviewer", async () => {
  const response = await catalog()
  expect(response.models).toBeArray()
  expect(response.data).toBeUndefined()
  const reviewer = response.models!.find(
    (model) => model.slug === "codex-auto-review",
  )!
  expect(reviewer.visibility).toBe("hide")
  expect(reviewer.supported_in_api).toBe(true)
  expect(reviewer.supported_reasoning_levels).toBeArray()
  expect(reviewer.truncation_policy).toBeObject()
  expect(
    response.models!.find((model) => model.slug === "gpt-5.6-sol")!
      .auto_review_model_override,
  ).toBe("codex-auto-review")
  expect(
    response.models!.some((model) =>
      String(model.slug).startsWith("gpt-image-"),
    ),
  ).toBe(false)
})

test("reviewer override follows the allowed public reviewer ID", async () => {
  const connection = getMutableProviderConnection("codex-test")!
  connection.models!.find(
    (model) => model.upstreamId === "codex-auto-review",
  )!.publicId = "my-reviewer"
  cacheModels()
  const response = await catalog(undefined, ["gpt-5.6-sol", "my-reviewer"])
  expect(
    response.models!.find((model) => model.slug === "gpt-5.6-sol")!
      .auto_review_model_override,
  ).toBe("my-reviewer")
})

test("ordinary OpenAI clients retain their existing model list", async () => {
  const response = await catalog("")
  expect(response.object).toBe("list")
  expect(response.data!.some((model) => model.id === "codex-auto-review")).toBe(
    true,
  )
  expect(response.models).toBeUndefined()
})

test("restricted callers cannot discover a disallowed reviewer", async () => {
  const response = await catalog(undefined, ["gpt-5.6-sol"])
  expect(response.models!.map((model) => model.slug)).toEqual(["gpt-5.6-sol"])
  expect(response.models![0].auto_review_model_override).toBeNull()
})

test("model discovery preserves native policy and capability metadata after public renaming", async () => {
  const policy = {
    policy: "native review policy",
    policy_template: "{{ tenant_policy_config }}",
  }
  globalThis.fetch = (async () =>
    Response.json({
      models: [
        {
          slug: "gpt-5.6-sol",
          display_name: "Sol",
          context_window: 321000,
          node_repl_auto_review_required: true,
          auto_review_model_override: "codex-auto-review",
          model_messages: { auto_review: policy },
          supported_reasoning_levels: [{ effort: "low", description: "Low" }],
        },
      ],
    })) as unknown as typeof fetch
  const connection = getMutableProviderConnection("codex-test")!
  await getCodexModelsForConnection(connection)
  const mapping = connection.models!.find(
    (model) => model.upstreamId === "gpt-5.6-sol",
  )!
  mapping.publicId = "my-sol"
  cacheModels()
  const response = await catalog()
  const model = response.models!.find((entry) => entry.slug === "my-sol")!
  expect(model.context_window).toBe(321000)
  expect(model.node_repl_auto_review_required).toBe(true)
  expect(model.auto_review_model_override).toBe("codex-auto-review")
  expect((model.model_messages as Record<string, unknown>).auto_review).toEqual(
    policy,
  )
})

test("legacy reasoning filtering never mutates the modern catalog", async () => {
  rememberCodexClientModels("codex-test", [
    {
      slug: "gpt-5.6-sol",
      default_reasoning_level: "ultra",
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "ultra", description: "Ultra" },
      ],
    },
  ])
  const old = await catalog("?client_version=0.137.0")
  const oldModel = old.models!.find((entry) => entry.slug === "gpt-5.6-sol")!
  expect(oldModel.supported_reasoning_levels).toEqual([
    { effort: "low", description: "Low" },
  ])
  expect(oldModel.default_reasoning_level).toBe("low")
  const modern = await catalog()
  expect(
    modern.models!.find((entry) => entry.slug === "gpt-5.6-sol")!
      .default_reasoning_level,
  ).toBe("ultra")
})

test("native metadata follows the selected catalog connection rather than the last refresh", async () => {
  const secondary = managedConnectionFromInput({
    id: "codex-secondary",
    name: "Secondary",
    provider: "codex",
    enabled: true,
    priority: 10,
    credentials: { accessToken: "test" },
  })
  secondary.models = getCodexFallbackModels()
  upsertProviderConnection(secondary)
  rememberCodexClientModels("codex-test", [
    { slug: "gpt-5.6-sol", context_window: 111000 },
  ])
  rememberCodexClientModels("codex-secondary", [
    { slug: "gpt-5.6-sol", context_window: 222000 },
  ])
  cacheModels()
  const response = await catalog()
  expect(
    response.models!.find((model) => model.slug === "gpt-5.6-sol")!
      .context_window,
  ).toBe(111000)
})

test("non-Codex providers never inherit native Codex tools from a matching model name", async () => {
  const connection = getMutableProviderConnection("codex-test")!
  connection.protocol = "openai-compatible"
  cacheModels()
  const response = await catalog()
  const model = response.models!.find((entry) => entry.slug === "gpt-5.6-sol")!
  expect(model.experimental_supported_tools).toEqual([])
  expect(model.apply_patch_tool_type).toBeNull()
  expect(model.node_repl_auto_review_required).toBeUndefined()
})

test("unknown reasoning levels cannot make the native catalog undecodable", async () => {
  rememberCodexClientModels("codex-test", [
    {
      slug: "gpt-5.6-sol",
      default_reasoning_level: "adaptive",
      supported_reasoning_levels: [
        { effort: "adaptive", description: "Unsupported" },
        { effort: "low", description: "Low" },
      ],
    },
  ])
  const response = await catalog()
  const model = response.models!.find((entry) => entry.slug === "gpt-5.6-sol")!
  expect(model.supported_reasoning_levels).toEqual([
    { effort: "low", description: "Low" },
  ])
  expect(model.default_reasoning_level).toBe("low")
})
