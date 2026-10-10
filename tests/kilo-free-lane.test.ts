import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import {
  BUILTIN_PROVIDER_PRESETS,
  type ProviderPreset,
} from "~/lib/provider-presets"
import { buildRouteTargets, listExposedPublicModels } from "~/lib/route-target"
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { findEffectiveCredential } from "~/lib/provider-connections/anonymous-credential"
import { buildBaseHeaders } from "~/services/protocols/shared"
import { openAICompatibleAdapter } from "~/services/protocols/openai-compatible"

/**
 * Kilo 免费池（匿名、无 Key）接入的回归守卫。
 *
 * 三条最容易 silently 坏掉的不变量：
 * 1. 连接不挂 credential 时**仍然可路由**（否则免费车道建了连不上）；
 * 2. 匿名请求**不能带 Authorization**（Kilo 对带头部的匿名请求回 401
 *    INVALID_TOKEN，实测 2026-10-09）；
 * 3. 模型发现只保留上游标记 `isFree` 的切片（`/models` 一次返回 390 个，
 *    其余匿名必 401）。
 */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function kiloPreset(): ProviderPreset {
  const preset = BUILTIN_PROVIDER_PRESETS.find((p) => p.id === "kilo-free")
  if (!preset) throw new Error("Missing kilo-free preset")
  return preset
}

describe("kilo free lane preset", () => {
  test("is registered as an anonymous, keyless free lane", () => {
    const preset = kiloPreset()
    expect(preset.category).toBe("free")
    expect(preset.keyless).toBe(true)
    expect(preset.protocol).toBe("openai-compatible")
    expect(preset.baseUrl).toBe("https://api.kilo.ai/api/gateway")
    // 匿名上游：预设不能带任何固定头，更不能带 Authorization
    expect(preset.headers).toBeUndefined()
  })

  test("ships the current free slice as default models", () => {
    const models = kiloPreset().defaultModels ?? []
    const ids = models.map((m) => m.upstreamId)
    // 2026-10-09 从上游 /models 实测的 isFree 切片(16 个)。上游会随时上下线
    // 模型,这份快照故意写死:漂移时测试失败,逼人重新核对而不是默默留一堆
    // 匿名必 401 的 id。注意有两个免费 id 不带 free 后缀(ling / glyph)。
    expect([...ids].sort()).toEqual(
      [
        "cohere/north-mini-code:free",
        "dots-studio/dots-3-note-preview:free",
        "inclusionai/ling-3.1-flash",
        "kilo-auto/free",
        "liquid/lfm-2.5-2.6b:free",
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
        "nvidia/nemotron-3.5-content-safety:free",
        "nvidia/nemotron-3.5-lightning:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "openrouter/free",
        "poolside/laguna-s-2.1:free",
        "poolside/laguna-xs-2.1:free",
        "stealth/glyph-cluster",
        "stepfun/step-5-preview-free",
        "thinkingmachines/inkling-small:free",
      ].sort(),
    )
    for (const model of models) expect(model.endpoints).toEqual(["chat"])
  })
})

describe("keyless connection routing", () => {
  function keylessConnection() {
    return {
      id: "kilo",
      name: "Kilo AI 免费池",
      protocol: "openai-compatible",
      baseUrl: "https://api.kilo.ai/api/gateway",
      enabled: true,
      priority: 10,
      credentials: [],
      createdAt: 1_700_000_000_000,
      models: [
        {
          publicId: "kilo-auto/free",
          upstreamId: "kilo-auto/free",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    }
  }

  test("a connection without credentials still produces route targets", () => {
    const targets = buildRouteTargets({
      connections: [keylessConnection() as never],
      endpoint: "chat",
      publicModelId: "kilo-auto/free",
      onlyAvailable: true,
    })
    expect(targets).toHaveLength(1)
    expect(targets[0]!.connectionId).toBe("kilo")
    expect(targets[0]!.endpoint).toBe("chat")
  })

  test("the anonymous credential is stable, so cooldowns accumulate", () => {
    const connection = keylessConnection()
    const first = buildRouteTargets({
      connections: [connection as never],
      endpoint: "chat",
      publicModelId: "kilo-auto/free",
    })
    const second = buildRouteTargets({
      connections: [connection as never],
      endpoint: "chat",
      publicModelId: "kilo-auto/free",
    })
    // 每个请求都新建一张白纸的话，429 打上的 cooldown 立刻蒸发
    expect(second[0]!.credentialId).toBe(first[0]!.credentialId)
    expect(first[0]!.credentialId).toBe("kilo")
  })

  test("a record whose credentials field is missing stays unroutable", () => {
    // 脏数据(旧 schema / 手改文件)与刻意的无密钥连接是两件事：前者继续
    // 按不可路由处理，不能因为免费车道的新能力突然变成可调度。
    const broken = keylessConnection() as unknown as Record<string, unknown>
    delete broken.credentials
    expect(
      buildRouteTargets({
        connections: [broken as never],
        endpoint: "chat",
        publicModelId: "kilo-auto/free",
        onlyAvailable: true,
      }),
    ).toEqual([])
  })

  test("anonymous credentials send no Authorization header", () => {
    const headers = buildBaseHeaders(
      keylessConnection() as unknown as ProviderConnection,
      {
        id: "kilo",
        authMode: "bearer",
        value: "",
        enabled: true,
        status: "ready",
        createdAt: 0,
      } as ApiCredential,
    )
    expect(headers["Authorization"]).toBeUndefined()
    expect(
      Object.keys(headers).some((key) => key.toLowerCase() === "authorization"),
    ).toBe(false)
  })

  test("a keyless connection still lists its models in the public catalog", () => {
    // 免费车道不挂 credential,但模型必须照常进 /v1/models——否则客户端拉不到,
    // 表现就是「拉取模型失败」。
    const exposed = listExposedPublicModels([keylessConnection() as never])
    expect(exposed.map((entry) => entry.publicId)).toContain("kilo-auto/free")
  })

  test("a record whose credentials field is missing stays out of the catalog", () => {
    // 与「刻意的无密钥连接」相反:脏数据不能因为免费车道的新能力突然可见。
    const broken = keylessConnection() as unknown as Record<string, unknown>
    delete broken.credentials
    expect(listExposedPublicModels([broken as never])).toEqual([])
  })

  test("the target's credentialId resolves to the anonymous credential", () => {
    // 准入 / 轮换按住 target.credentialId 反查凭据;免密连接的 id 就是
    // connection.id,必须能解析到合成匿名凭据,否则表现为 503
    // "Route target resolution failed"。
    const connection = keylessConnection()
    const targets = buildRouteTargets({
      connections: [connection as never],
      endpoint: "chat",
      publicModelId: "kilo-auto/free",
    })
    const credential = findEffectiveCredential(
      connection as never,
      targets[0]!.credentialId,
    )
    expect(credential?.id).toBe("kilo")
    expect(credential?.value).toBe("")
  })
})

describe("free-only model discovery", () => {
  test("keeps only the upstream isFree slice", async () => {
    const calls: Array<string> = []
    globalThis.fetch = ((input: string) => {
      calls.push(String(input))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: "kilo-auto/free", isFree: true },
              { id: "nvidia/nemotron-3-ultra-550b-a55b:free", isFree: true },
              { id: "anthropic/claude-opus-4.5", isFree: false },
              { id: "openai/gpt-5.2" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }) as unknown as typeof globalThis.fetch

    const models = await openAICompatibleAdapter.discoverModels!({
      connection: {
        id: "kilo",
        name: "Kilo AI 免费池",
        protocol: "openai-compatible",
        baseUrl: "https://api.kilo.ai/api/gateway",
        enabled: true,
        priority: 0,
        credentials: [],
        createdAt: 0,
        modelDiscovery: { enabled: true, freeOnly: true },
      } as never,
      credential: {
        id: "kilo",
        authMode: "bearer",
        value: "",
        enabled: true,
        status: "ready",
        createdAt: 0,
      } as never,
    })

    // joinUrl 自动补 /v1：上游两个形状都服务（实测 200）
    expect(calls).toEqual(["https://api.kilo.ai/api/gateway/v1/models"])
    expect(models.map((m) => m.publicId)).toEqual([
      "kilo-auto/free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    ])
  })

  test("without the flag discovery still returns the whole catalog", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: "kilo-auto/free", isFree: true },
              { id: "anthropic/claude-opus-4.5", isFree: false },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )) as unknown as typeof globalThis.fetch

    const models = await openAICompatibleAdapter.discoverModels!({
      connection: {
        id: "other",
        name: "other",
        protocol: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        enabled: true,
        priority: 0,
        credentials: [],
        createdAt: 0,
        modelDiscovery: { enabled: true },
      } as never,
      credential: {
        id: "other",
        authMode: "bearer",
        value: "sk-x",
        enabled: true,
        status: "ready",
        createdAt: 0,
      } as never,
    })
    expect(models.map((m) => m.publicId)).toHaveLength(2)
  })
})

describe("connections view keyless flow", () => {
  interface ModelRow {
    publicId: string
    upstreamId?: string
    endpoints?: Array<string>
  }
  interface ConnectionView {
    connForm: {
      name: string
      apiKey: string
      baseUrl: string
      protocol: string
      customHeaders: Array<{ key: string; value: string }>
      _credentialId?: string
    }
    fetchedModels: Array<ModelRow>
    selectedModelIds: Array<string>
    selectedPreset: ProviderPreset | null
    selectPreset(preset: ProviderPreset): void
    openEdit(connection: Record<string, unknown>): void
    customHeadersToRecord(): Record<string, string> | undefined
    fetchRemoteModels(): Promise<void>
    saveConn(): Promise<void>
  }

  function createView(
    requests: Array<{ method: string; payload: Record<string, unknown> }>,
  ): ConnectionView {
    const view = runInNewContext(
      readFileSync("pages/js/views/connections.js", "utf8")
        + "\nconnectionsView()",
      {
        ViewHelpers: {},
        API: {
          providerConnections: {
            fetchModels: (payload: Record<string, unknown>) => {
              requests.push({ method: "fetch", payload })
              return Promise.resolve({
                models: [
                  { publicId: "kilo-auto/free", upstreamId: "kilo-auto/free" },
                ],
              })
            },
            create: (payload: Record<string, unknown>) => {
              requests.push({ method: "create", payload })
              return Promise.resolve({ connection: { id: "kilo" } })
            },
          },
        },
      },
    ) as ConnectionView & { $nextTick: () => void; showToast(): void }
    view.$nextTick = () => {}
    view.showToast = () => {}
    Object.assign(view, { t: (key: string) => key })
    return view
  }

  test("free lane probes and saves without any API key", async () => {
    const requests: Array<{
      method: string
      payload: Record<string, unknown>
    }> = []
    const view = createView(requests)
    view.selectPreset(kiloPreset())

    // 预设自带免费切片，进弹窗就能直接勾选
    expect(view.fetchedModels.length).toBeGreaterThanOrEqual(16)
    expect(view.selectedModelIds).toContain("kilo-auto/free")

    await view.fetchRemoteModels()
    expect(requests.map((r) => r.method)).toEqual(["fetch"])
    // 匿名探测：不带 key，并要求只保留 isFree 切片
    expect(requests[0]!.payload.apiKey).toBe("")
    expect(requests[0]!.payload.freeOnly).toBe(true)
    // 没有 key 就没有 Authorization：连接上不能落任何 credential
    expect(requests[0]!.payload.headers).toBeUndefined()

    await view.saveConn()
    expect(requests.map((r) => r.method)).toEqual(["fetch", "create"])
    expect(requests[1]!.payload.credentials).toBeUndefined()
    expect(requests[1]!.payload.baseUrl).toBe("https://api.kilo.ai/api/gateway")
    // freeOnly 必须随连接落库:连接行上的「刷新模型」否则会把整份付费目录灌进来
    expect(requests[1]!.payload.modelDiscovery).toEqual({
      enabled: true,
      mode: "manual-only",
      freeOnly: true,
    })
  })

  test("saved keyless connections can probe models while editing and preserve freeOnly", async () => {
    for (const protocol of ["openai-compatible", "opencode-zen-free"]) {
      const requests: Array<{
        method: string
        payload: Record<string, unknown>
      }> = []
      const view = createView(requests)
      view.openEdit({
        id: "free-lane",
        name: "Free lane",
        protocol,
        baseUrl: "https://example.test",
        credentials: [],
        models: [],
        modelDiscovery: { enabled: true, mode: "manual-only", freeOnly: true },
      })
      await view.fetchRemoteModels()
      expect(requests.map((request) => request.method)).toEqual(["fetch"])
      expect(requests[0]!.payload.apiKey).toBe("")
      expect(requests[0]!.payload.freeOnly).toBe(true)
    }
  })

  test("keyless discovery does not imply freeOnly for custom endpoints", async () => {
    const requests: Array<{
      method: string
      payload: Record<string, unknown>
    }> = []
    const view = createView(requests)
    view.openEdit({
      id: "custom",
      name: "Custom",
      protocol: "openai-compatible",
      baseUrl: "https://example.test",
      credentials: [],
      models: [],
    })
    await view.fetchRemoteModels()
    expect(requests.map((request) => request.method)).toEqual(["fetch"])
    expect(requests[0]!.payload.freeOnly).toBeUndefined()
  })

  test("missing credentials do not bypass the editor API key requirement", async () => {
    const requests: Array<{
      method: string
      payload: Record<string, unknown>
    }> = []
    const view = createView(requests)
    view.openEdit({
      id: "incomplete",
      name: "Incomplete",
      protocol: "openai-compatible",
      baseUrl: "https://example.test",
      models: [],
    })
    await view.fetchRemoteModels()
    expect(requests).toEqual([])
  })
})
