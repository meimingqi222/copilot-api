import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface ConfigView {
  settings: { codexModelIds: Array<string> | null } | null
  loading: boolean
  saving: boolean
  saved: boolean
  error: string
  codexModels: Array<{ id: string; name: string }>
  codexModelsError: string
  load: () => Promise<void>
  save: () => Promise<void>
}

const source = readFileSync(
  new URL("../pages/js/views/system-config.js", import.meta.url),
  "utf8",
)
const config = {
  settings: { codexModelIds: null, logMaxTotalBytes: 1024 * 1024 },
  source: "default",
  expiresAt: null,
}

function createView(options: {
  request: (path: string, options?: { method?: string }) => Promise<unknown>
  confirm?: () => boolean
}): ConfigView {
  return runInNewContext(`${source}\nsystemConfigView()`, {
    API: { request: options.request },
    I18n: { t: (key: string) => key },
    confirm: options.confirm ?? (() => true),
    dispatchEvent: () => true,
    CustomEvent,
  }) as ConfigView
}

test("catalog failure leaves system configuration editable and saveable", async () => {
  let saves = 0
  const view = createView({
    request: (path, options) => {
      if (path.endsWith("/codex-models")) {
        return Promise.reject(new Error("Catalog unavailable"))
      }
      if (options?.method === "PUT") saves++
      return Promise.resolve(structuredClone(config))
    },
  })
  await view.load()
  expect(view.settings).not.toBeNull()
  expect(view.loading).toBe(false)
  expect(view.error).toBe("")
  expect(view.codexModels).toEqual([])
  expect(view.codexModelsError).toBe("Catalog unavailable")
  await view.save()
  expect(saves).toBe(1)
  expect(view.saved).toBe(true)
})

test("a pending catalog does not block loading or saving configuration", async () => {
  let resolveCatalog: (value: unknown) => void = () => {}
  const catalog = new Promise<unknown>((resolve) => {
    resolveCatalog = resolve
  })
  const view = createView({
    request: (path) =>
      path.endsWith("/codex-models") ? catalog : Promise.resolve(config),
  })
  try {
    const outcome = await Promise.race([
      view.load().then(() => "loaded"),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("blocked"), 100)
      }),
    ])
    expect(outcome).toBe("loaded")
    expect(view.settings).not.toBeNull()
    await view.save()
    expect(view.saved).toBe(true)
  } finally {
    resolveCatalog({ models: [] })
  }
})

test("empty custom model selection requires confirmation before saving", async () => {
  let accepted = false
  let confirmations = 0
  let saves = 0
  const view = createView({
    confirm: () => {
      confirmations++
      return accepted
    },
    request: (_path, options) => {
      if (options?.method === "PUT") saves++
      return Promise.resolve(structuredClone(config))
    },
  })
  view.settings = { codexModelIds: [] }
  await view.save()
  expect(confirmations).toBe(1)
  expect(saves).toBe(0)
  expect(view.saving).toBe(false)
  accepted = true
  await view.save()
  expect(confirmations).toBe(2)
  expect(saves).toBe(1)
  expect(view.saved).toBe(true)
})
