import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { nearestEffort } from "~/lib/effort-levels"
import { clampEffortForModel, effortsForModel } from "~/lib/reasoning-effort"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { server } from "~/server"
import { buildCodexClientModelsResponse } from "~/services/codex/client-models"

const originalPath = PATHS.APP_DIR
const originalModels = state.models
const originalFetch = globalThis.fetch
let testDir: string

function windsurfConnection(
  id: string,
  priority: number,
  efforts: Array<string>,
): Parameters<typeof upsertProviderConnection>[0] {
  return {
    id,
    name: id,
    protocol: "windsurf-native",
    baseUrl: "https://api.windsurf.example",
    enabled: true,
    priority,
    createdAt: Date.now(),
    credentials: [
      {
        id: `${id}-cred`,
        authMode: "bearer",
        value: "token",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
      },
    ],
    models: [
      {
        publicId: "glm-5-2",
        upstreamId: "glm-5-2",
        name: "GLM-5.2",
        vendor: "Zai",
        endpoints: ["chat"],
        enabled: true,
        pickerEnabled: true,
        efforts,
      },
    ],
  }
}

beforeEach(async () => {
  await fs.mkdir("temp", { recursive: true })
  testDir = await fs.mkdtemp(path.resolve("temp/reasoning-effort-"))
  redirectPathsToDir(testDir)
  __resetProviderConnectionsForTest()
  resetProtectedRouteGuardForTest()
})

afterEach(async () => {
  redirectPathsToDir(originalPath)
  __resetProviderConnectionsForTest()
  globalThis.fetch = originalFetch
  state.models = originalModels
  await fs.rm(testDir, { recursive: true, force: true })
})

describe("nearestEffort", () => {
  // 与 magpie 的 fitEffort 用例逐条对齐：平局往上，永不降成 none。
  test("picks the model's own nearest level, a tie going up", () => {
    const glm = ["low", "high", "max"]
    expect(nearestEffort("medium", glm)).toBe("high")
    expect(nearestEffort("low", glm)).toBe("low")
    expect(nearestEffort("xhigh", glm)).toBe("max")
    expect(nearestEffort("max", ["low", "medium", "high"])).toBe("high")
    expect(nearestEffort("low", ["none", "minimal", "medium"])).toBe("medium")
    expect(nearestEffort("medium", ["low", "high"])).toBe("high")
  })

  test("leaves the request alone when the levels are unknown or list it", () => {
    expect(nearestEffort("medium", undefined)).toBe("medium")
    expect(nearestEffort("medium", [])).toBe("medium")
    expect(nearestEffort("medium", ["none"])).toBe("medium")
    expect(nearestEffort("max", ["low", "high", "max"])).toBe("max")
    // 不认识的档位不猜
    expect(nearestEffort("turbo", ["low", "high"])).toBe("turbo")
  })
})

describe("clampEffortForModel", () => {
  test("clamps against the levels the model advertises", () => {
    state.models = {
      object: "list",
      data: [
        {
          id: "glm-5-2",
          object: "model",
          name: "GLM-5.2",
          preview: false,
          vendor: "Zai",
          version: "1",
          model_picker_enabled: true,
          capabilities: {
            family: "zai",
            object: "capabilities",
            supports: { streaming: true, reasoning_effort: ["low", "high"] },
            tokenizer: "unknown",
            type: "chat",
          },
        },
      ],
    }

    expect(effortsForModel("glm-5-2")).toEqual(["low", "high"])
    expect(clampEffortForModel("glm-5-2", "max")).toBe("high")
    expect(clampEffortForModel("glm-5-2", "medium")).toBe("high")
    expect(clampEffortForModel("glm-5-2", "low")).toBe("low")
  })

  test("keeps switch semantics and folds Codex's ultra to max", () => {
    expect(clampEffortForModel("unknown-model", "ultra")).toBe("max")
    expect(clampEffortForModel("unknown-model", "max")).toBe("max")
    expect(clampEffortForModel("unknown-model", "none")).toBe("none")
    expect(clampEffortForModel("unknown-model", "auto")).toBe("auto")
    expect(clampEffortForModel("unknown-model", undefined)).toBeUndefined()
    expect(effortsForModel("unknown-model")).toBeUndefined()
  })
})

test("cacheModels advertises the levels every connection serving an id accepts", () => {
  upsertProviderConnection(windsurfConnection("ws-a", 0, ["low", "high"]))
  upsertProviderConnection(windsurfConnection("ws-b", 1, ["high", "max"]))
  cacheModels()

  const [entry] = state.models?.data ?? []
  // 交集：落到哪个 target 都不会被上游拒绝。
  expect(entry?.capabilities.supports.reasoning_effort).toEqual(["high"])

  // Codex 客户端目录走同一份投影。
  const catalog = buildCodexClientModelsResponse(
    state.models?.data ?? [],
    "0.160.0",
    null,
  )
  const listed = catalog.models.find((model) => model.slug === "glm-5-2")
  expect(listed?.supported_reasoning_levels).toEqual([
    { effort: "high", description: "high" },
  ])
})

test("chat route clamps the requested effort to the model's levels", async () => {
  await createConnection({
    id: "openai-conn",
    name: "openai",
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test",
    credentials: [{ id: "cred", value: "sk-test", authMode: "bearer" }],
    models: [
      {
        publicId: "glm-5-2",
        upstreamId: "glm-5-2",
        endpoints: ["chat"],
        enabled: true,
        efforts: ["low", "high"],
      },
    ],
  })
  cacheModels()

  const fetchMock = mock((_url: string, _opts?: { body?: string }) => ({
    ok: true,
    json: () => ({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "glm-5-2",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    text: () => Promise.resolve(""),
    status: 200,
    headers: {},
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const post = (body: Record<string, unknown>) =>
    server.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-5-2",
          messages: [{ role: "user", content: "hi" }],
          ...body,
        }),
      }),
    )

  // 后缀档位：模型只有 low/high，max 必须落回 high。
  expect((await post({ model: "glm-5-2(max)" })).status).toBe(200)
  // 客户端自带的档位同样钳制。
  expect((await post({ reasoning_effort: "medium" })).status).toBe(200)

  const sent = fetchMock.mock.calls.map(
    (call) =>
      JSON.parse(call[1]?.body ?? "{}") as { reasoning_effort?: string },
  )
  expect(sent.map((body) => body.reasoning_effort)).toEqual(["high", "high"])
})
