/**
 * 端点连接弹窗的"代理 URL"字段回归测试。
 *
 * 运行时是 Bun，连接级代理靠 Bun 原生 fetch 的 `proxy` 选项生效；能把
 * `proxyUrl` 配上并送到 Admin API，是 adapter 侧透传（见
 * tests/connection-proxy-wiring.test.ts）之外的另一半链路。
 *
 * 这里用 vm 直接跑 pages/js/views/connections.js：断言弹窗回显已有代理、
 * 保存与"在线获取模型"都把 proxyUrl 放进请求体。
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface ConnFormState {
  id: string | null
  name: string
  protocol: string
  baseUrl: string
  proxyUrl: string
  apiKey: string
  customHeaders: Array<{ key: string; value: string }>
}

interface ConnectionsView {
  connForm: ConnFormState
  selectedPreset: unknown
  fetchedModels: Array<{ publicId: string; enabled?: boolean }>
  selectedModelIds: Array<string>
  showConnModal: boolean
  openEdit(conn: Record<string, unknown>): void
  saveConn(): Promise<void>
  fetchRemoteModels(): Promise<void>
  customHeadersToRecord(): Record<string, string> | undefined
}

const PROXY = "http://127.0.0.1:7890"

function createView(
  requests: Array<{ method: string; payload: Record<string, unknown> }>,
): ConnectionsView {
  const view = runInNewContext(
    readFileSync("pages/js/views/connections.js", "utf8")
      + "\nconnectionsView()",
    {
      ViewHelpers: {},
      API: {
        providerConnections: {
          update: (id: string, payload: Record<string, unknown>) => {
            requests.push({ method: "update", payload })
            return Promise.resolve({ connection: { id } })
          },
          create: (payload: Record<string, unknown>) => {
            requests.push({ method: "create", payload })
            return Promise.resolve({ connection: { id: "new-conn" } })
          },
          fetchModels: (payload: Record<string, unknown>) => {
            requests.push({ method: "fetch", payload })
            return Promise.resolve({ models: [] })
          },
        },
      },
    },
  ) as ConnectionsView & {
    $nextTick: (fn: () => void) => void
    load: () => Promise<void>
    showToast: () => void
  }
  view.$nextTick = () => undefined
  view.load = () => Promise.resolve()
  view.showToast = () => undefined
  return view
}

test("openEdit reflects the stored proxyUrl", () => {
  const view = createView([])
  view.openEdit({
    id: "stepfun",
    name: "stepfun",
    protocol: "openai-compatible",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    proxyUrl: PROXY,
    priority: 10,
    weight: 1,
    enabled: true,
    credentials: [{ id: "cred-1" }],
    models: [],
  })
  expect(view.connForm.proxyUrl).toBe(PROXY)
})

test("saveConn sends proxyUrl, and an emptied field clears it", async () => {
  const requests: Array<{ method: string; payload: Record<string, unknown> }> =
    []
  const view = createView(requests)
  view.openEdit({
    id: "stepfun",
    name: "stepfun",
    protocol: "openai-compatible",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    proxyUrl: PROXY,
    priority: 10,
    weight: 1,
    enabled: true,
    credentials: [{ id: "cred-1" }],
    models: [],
  })

  await view.saveConn()
  expect(requests[0]?.method).toBe("update")
  expect(requests[0]?.payload.proxyUrl).toBe(PROXY)

  view.connForm.proxyUrl = ""
  await view.saveConn()
  // 空串是"清除"语义，由 PUT 路由翻译成 null。
  expect(requests[1]?.payload.proxyUrl).toBe("")
})

test("fetchRemoteModels probes through the configured proxy", async () => {
  const requests: Array<{ method: string; payload: Record<string, unknown> }> =
    []
  const view = createView(requests)
  view.openEdit({
    id: "stepfun",
    name: "stepfun",
    protocol: "openai-compatible",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    proxyUrl: PROXY,
    priority: 10,
    weight: 1,
    enabled: true,
    credentials: [{ id: "cred-1" }],
    models: [],
  })
  view.connForm.apiKey = "sk-test"

  await view.fetchRemoteModels()

  expect(requests[0]?.method).toBe("fetch")
  expect(requests[0]?.payload.proxyUrl).toBe(PROXY)
})
