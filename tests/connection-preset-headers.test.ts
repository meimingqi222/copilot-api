import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import {
  BUILTIN_PROVIDER_PRESETS,
  type ProviderPreset,
} from "~/lib/provider-presets"
import { anthropicCompatibleAdapter } from "~/services/protocols/anthropic-compatible"
import { afterEach } from "bun:test"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const expectedHeaders = {
  "User-Agent": "KimiCLI/1.52.0",
  "X-Msh-Platform": "kimi_cli",
  "X-Msh-Version": "1.52.0",
}
interface ModelRow {
  publicId: string
  upstreamId?: string
  tier?: string
  metadata?: Record<string, unknown>
  endpoints?: Array<string>
}
interface ConnectionView {
  connForm: {
    name: string
    apiKey: string
    customHeaders: Array<{ key: string; value: string }>
  }
  fetchedModels: Array<ModelRow>
  selectedModelIds: string[]
  selectPreset(preset: ProviderPreset): void
  selectCustomPreset(): void
  openEdit(conn: Record<string, unknown>): void
  customHeadersToRecord(): Record<string, string> | undefined
  fetchRemoteModels(): Promise<void>
  saveConn(): Promise<void>
  load(): Promise<void>
  showToast(): void
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
            return Promise.resolve({ models: [] })
          },
          create: (payload: Record<string, unknown>) => {
            requests.push({ method: "create", payload })
            return Promise.resolve({ connection: { id: "synthetic" } })
          },
        },
      },
    },
  ) as ConnectionView & { $nextTick: () => void }
  view.$nextTick = () => {}
  view.showToast = () => {}
  view.load = () => Promise.resolve()
  return view
}
function kimiPreset(): ProviderPreset {
  const preset = BUILTIN_PROVIDER_PRESETS.find(
    (p) => p.id === "moonshot-coding",
  )
  if (!preset) throw new Error("Missing Kimi Coding preset")
  return preset
}

test("Kimi Coding selection prefills editable headers, without device identifiers or carrying them to another preset", () => {
  const view = createView([])
  const preset = kimiPreset()
  view.selectPreset(preset)
  expect(view.customHeadersToRecord()).toEqual(expectedHeaders)
  expect(Object.keys(view.customHeadersToRecord()!)).toHaveLength(3)
  view.connForm.customHeaders[0].value = "custom-client/1"
  view.selectPreset(preset)
  expect(view.customHeadersToRecord()).toEqual(expectedHeaders)
  view.selectPreset(BUILTIN_PROVIDER_PRESETS.find((p) => p.id === "deepseek")!)
  expect(view.customHeadersToRecord()).toBeUndefined()
  view.selectPreset(preset)
  view.selectCustomPreset()
  expect(view.customHeadersToRecord()).toBeUndefined()
})

test("edited preset headers are sent both when probing models and creating a connection", async () => {
  const requests: Array<{ method: string; payload: Record<string, unknown> }> =
    []
  const view = createView(requests)
  view.selectPreset(kimiPreset())
  view.connForm.apiKey = "sk-synthetic-test"
  view.connForm.customHeaders.find(
    (entry) => entry.key === "User-Agent",
  )!.value = "custom-client/1"
  await view.fetchRemoteModels()
  await view.saveConn()
  expect(requests.map((request) => request.method)).toEqual(["fetch", "create"])
  for (const { payload } of requests)
    expect(payload.headers).toEqual({
      ...expectedHeaders,
      "User-Agent": "custom-client/1",
    })
})

test("Anthropic model discovery sends configured Kimi client headers and credential authentication", async () => {
  let sent: Headers | undefined
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    sent = new Headers(init?.headers)
    return Promise.resolve(Response.json({ data: [{ id: "kimi-for-coding" }] }))
  }) as typeof fetch
  const models = await anthropicCompatibleAdapter.discoverModels!({
    connection: {
      id: "synthetic",
      name: "synthetic",
      protocol: "anthropic-compatible",
      baseUrl: "https://api.kimi.com/coding",
      enabled: true,
      priority: 0,
      credentials: [],
      createdAt: 0,
      headers: expectedHeaders,
    },
    credential: {
      id: "synthetic-key",
      value: "sk-synthetic-test",
      authMode: "header",
      headerName: "x-api-key",
      enabled: true,
      status: "ready",
      createdAt: 0,
    },
  })
  expect(models[0].publicId).toBe("kimi-for-coding")
  expect(sent?.get("User-Agent")).toBe(expectedHeaders["User-Agent"])
  expect(sent?.get("X-Msh-Platform")).toBe("kimi_cli")
  expect(sent?.get("X-Msh-Version")).toBe("1.52.0")
  expect(sent?.get("x-api-key")).toBe("sk-synthetic-test")
})

test("Kimi Code model tiers reach the model list, the Save payload and the next edit", async () => {
  const requests: Array<{ method: string; payload: Record<string, unknown> }> =
    []
  const view = createView(requests)
  view.selectPreset(kimiPreset())
  // 档位标签来自预设数据：显示在模型列表上，但不挡勾选（能不能用由上游判定）
  expect(view.fetchedModels.map((m) => [m.publicId, m.tier])).toEqual([
    ["kimi-for-coding", undefined],
    ["kimi-for-coding-highspeed", "Pro+"],
    ["k3", "Plus+"],
    ["k3-256k", "Plus+"],
  ])
  expect(view.selectedModelIds).toHaveLength(4)

  view.connForm.apiKey = "sk-synthetic-test"
  await view.saveConn()
  const created = requests.find(
    (request) => request.method === "create",
  )!.payload
  const stored = (created.models as Array<ModelRow>).map((m) => [
    m.publicId,
    m.metadata?.tier,
  ])
  expect(stored).toContainEqual(["k3", "Plus+"])
  expect(stored).toContainEqual(["kimi-for-coding", undefined])

  // 编辑已有连接：标签从落库的 metadata 回来，否则一编辑就消失了
  view.openEdit({ ...created, id: "synthetic", credentials: [], createdAt: 0 })
  expect(view.fetchedModels.find((m) => m.publicId === "k3")?.tier).toBe(
    "Plus+",
  )
})
