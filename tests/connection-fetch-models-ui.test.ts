/**
 * 编辑连接弹窗「在线获取模型」合并回归。
 *
 * 已有模型改名或加过别名后,上游仍按原 publicId 返回同一条。编辑模式只按
 * publicId 判重时会把原名再追加一遍;判重必须覆盖 publicId / upstreamId /
 * aliases。
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface ModelRow {
  publicId: string
  upstreamId?: string
  aliases?: Array<string>
  enabled?: boolean
}

interface ConnectionView {
  connForm: { id: string | null; apiKey: string; baseUrl: string }
  fetchedModels: Array<ModelRow>
  selectedModelIds: Array<string>
  openEdit(conn: Record<string, unknown>): void
  fetchRemoteModels(): Promise<void>
}

function createView(remoteModels: Array<ModelRow>): ConnectionView {
  const view = runInNewContext(
    readFileSync("pages/js/views/connections.js", "utf8")
      + "\nconnectionsView()",
    {
      ViewHelpers: {},
      API: {
        providerConnections: {
          fetchModels: () => Promise.resolve({ models: remoteModels }),
        },
      },
    },
  ) as ConnectionView & { $nextTick: () => void; showToast(): void }
  view.$nextTick = () => undefined
  view.showToast = () => undefined
  return view
}

test("edit-mode fetch keeps renamed and aliased models instead of re-adding them", async () => {
  const view = createView([
    { publicId: "gpt-4o", upstreamId: "gpt-4o" },
    { publicId: "gpt-4o-mini", upstreamId: "gpt-4o-mini" },
    { publicId: "brand-new", upstreamId: "brand-new" },
  ])
  view.openEdit({
    id: "conn",
    name: "conn",
    protocol: "openai-compatible",
    baseUrl: "https://example.test/v1",
    credentials: [{ id: "cred-1" }],
    models: [
      {
        publicId: "my-gpt",
        upstreamId: "gpt-4o",
        aliases: ["gpt-4o"],
        enabled: true,
      },
      {
        publicId: "mini",
        upstreamId: "custom-mini",
        aliases: ["GPT-4O-MINI"],
        enabled: true,
      },
    ],
  })
  view.connForm.apiKey = "sk-test"

  await view.fetchRemoteModels()

  expect(view.fetchedModels.map((m) => m.publicId)).toEqual([
    "my-gpt",
    "mini",
    "brand-new",
  ])
  expect(
    view.fetchedModels.find((m) => m.publicId === "my-gpt")?.aliases,
  ).toEqual(["gpt-4o"])
  expect(
    view.fetchedModels.find((m) => m.publicId === "brand-new")?.enabled,
  ).toBe(false)
  expect(view.selectedModelIds).toEqual(["my-gpt", "mini"])
})
