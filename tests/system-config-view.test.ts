import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { getSystemConfig, initializeSystemConfig } from "~/lib/system-config"
import { systemConfigApiRoutes } from "~/routes/admin/api/system-config"

test("system settings display MiB and save the selected storage budget", async () => {
  const settings = {
    logRetentionDays: 7,
    logMaxTotalBytes: 1024 ** 3,
    concurrencyQueueLimit: 100,
    concurrencyQueueWaitSeconds: 30,
    redaction: {
      enabled: false,
      secrets: true,
      homePaths: false,
      wordsEnabled: true,
      words: ["private.example"],
      homePrefixes: ["/srv/private-user"],
    },
  }
  const originalRedaction = structuredClone(settings.redaction)
  const selectedRedaction = {
    ...originalRedaction,
    enabled: true,
    secrets: false,
    homePaths: true,
    wordsEnabled: false,
  }
  let submitted:
    | {
        logRetentionDays: number
        logMaxTotalBytes: number
        concurrencyQueueLimit: number
        concurrencyQueueWaitSeconds: number
        redaction: typeof settings.redaction
      }
    | undefined
  const source = readFileSync("pages/js/views/system-config.js", "utf8")
  const view = runInNewContext(source + "\nsystemConfigView()", {
    CustomEvent: class {},
    dispatchEvent: () => {},
    API: {
      request: (_path: string, options: { body: typeof settings }) => {
        submitted = options.body
        return Promise.resolve({
          settings: options.body,
          source: "webui",
          expiresAt: null,
        })
      },
    },
  }) as {
    settings: typeof settings
    maxLogMiB: number
    saved: boolean
    accept: (value: unknown) => void
    save: () => Promise<void>
    useRecommended: () => void
  }
  view.accept({ settings, source: "environment", expiresAt: null })
  expect(view.maxLogMiB).toBe(1024)
  view.settings.logRetentionDays = 3
  view.settings.concurrencyQueueLimit = 64
  view.settings.concurrencyQueueWaitSeconds = 12
  view.settings.redaction.enabled = true
  view.settings.redaction.secrets = false
  view.settings.redaction.homePaths = true
  view.settings.redaction.wordsEnabled = false
  view.maxLogMiB = 128
  await view.save()
  expect(submitted?.logMaxTotalBytes).toBe(128 * 1024 * 1024)
  expect(submitted?.logRetentionDays).toBe(3)
  expect(submitted?.concurrencyQueueLimit).toBe(64)
  expect(submitted?.concurrencyQueueWaitSeconds).toBe(12)
  expect(submitted?.redaction).toEqual(selectedRedaction)
  expect(view.saved).toBe(true)
  view.useRecommended()
  expect(view.maxLogMiB).toBe(1024)
  expect(view.settings.concurrencyQueueLimit).toBe(100)
  expect(view.settings.concurrencyQueueWaitSeconds).toBe(30)
  expect(view.settings.logRetentionDays).toBe(7)
  expect(view.settings.redaction).toEqual(selectedRedaction)
  view.settings.redaction.enabled = false
  await view.save()
  expect(submitted?.redaction).toEqual({ ...selectedRedaction, enabled: false })
})

test("redaction editors save literal lines through the API and retain invalid drafts without changing stored rules", async () => {
  let stored: string | undefined
  initializeSystemConfig({
    save: (value) => {
      stored = value
    },
    onChange: () => {},
  })
  const source = readFileSync("pages/js/views/system-config.js", "utf8")
  const view = runInNewContext(source + "\nsystemConfigView()", {
    CustomEvent: class {},
    dispatchEvent: () => {},
    API: {
      async request(_path: string, options: { body: unknown }) {
        const response = await systemConfigApiRoutes.request("/", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.body),
        })
        const value = (await response.json()) as { error?: string }
        if (!response.ok) throw new Error(value.error)
        return value
      },
    },
  }) as {
    settings: ReturnType<typeof getSystemConfig>["settings"]
    redactionWordsText: string
    redactionHomePrefixesText: string
    error: string
    saved: boolean
    accept: (value: unknown) => void
    save: () => Promise<void>
    useRecommended: () => void
  }
  try {
    view.accept(getSystemConfig())
    view.settings.redaction.enabled = false
    view.settings.redaction.wordsEnabled = false
    view.settings.redaction.homePaths = false
    view.redactionWordsText = "  private.example \r\n\nfoo.*bar\nhost,part\n"
    view.redactionHomePrefixesText = " /srv/private-user \nC:\\Users\\Private\n"
    view.useRecommended()
    await view.save()
    expect(view.error).toBe("")
    expect(view.saved).toBe(true)
    const saved = getSystemConfig().settings.redaction
    expect(saved.words).toEqual(["private.example", "foo.*bar", "host,part"])
    expect(saved.homePrefixes).toEqual([
      "/srv/private-user",
      "C:\\Users\\Private",
    ])
    expect(saved.enabled).toBe(false)
    expect(saved.wordsEnabled).toBe(false)
    expect(saved.homePaths).toBe(false)
    view.accept(getSystemConfig())
    expect(view.redactionWordsText).toBe("private.example\nfoo.*bar\nhost,part")
    expect(view.redactionHomePrefixesText).toBe(
      "/srv/private-user\nC:\\Users\\Private",
    )
    const persisted = stored
    for (const invalid of [
      "x",
      "x".repeat(1025),
      Array.from({ length: 101 }, (_, i) => `word-${i}`).join("\n"),
    ]) {
      view.redactionWordsText = invalid
      await view.save()
      expect(view.saved).toBe(false)
      expect(view.error).not.toBe("")
      expect(view.redactionWordsText).toBe(invalid)
      expect(stored).toBe(persisted)
      expect(getSystemConfig().settings.redaction.words).toEqual(saved.words)
    }
    view.redactionWordsText = "\n  \n"
    view.redactionHomePrefixesText = ""
    await view.save()
    expect(view.error).toBe("")
    expect(getSystemConfig().settings.redaction.words).toEqual([])
    expect(getSystemConfig().settings.redaction.homePrefixes).toEqual([])
  } finally {
    initializeSystemConfig({ save: () => {}, onChange: () => {} })
  }
})

test("Codex picker loads all choices, searches IDs, enforces 100 selections, reorders and saves", async () => {
  const source = readFileSync("pages/js/views/system-config.js", "utf8")
  const models = Array.from({ length: 102 }, (_, index) => ({
    id: `model-${index}`,
    name: `Model ${index}`,
  }))
  let submitted: { codexModelIds: Array<string> | null } | undefined
  const view = runInNewContext(source + "\nsystemConfigView()", {
    CustomEvent: class {},
    dispatchEvent: () => {},
    API: {
      request: (
        url: string,
        options?: { body: { codexModelIds: Array<string> | null } },
      ) => {
        if (url.endsWith("/codex-models")) return Promise.resolve({ models })
        if (options) submitted = options.body
        return Promise.resolve({
          settings: options?.body ?? {
            logMaxTotalBytes: 1024 ** 3,
            codexModelIds: null,
          },
          source: "webui",
          expiresAt: null,
        })
      },
    },
  }) as {
    settings: { codexModelIds: Array<string> | null }
    codexModels: typeof models
    codexModelSearch: string
    filteredCodexModels: typeof models
    saved: boolean
    load: () => Promise<void>
    save: () => Promise<void>
    useRecommended: () => void
    setCustomCodexModels: (enabled: boolean) => void
    toggleCodexModel: (id: string, checked: boolean) => void
    moveCodexModel: (index: number, direction: number) => void
  }
  await view.load()
  expect(view.codexModels).toHaveLength(102)
  view.codexModelSearch = "MODEL-101"
  expect(view.filteredCodexModels.map((model) => model.id)).toEqual([
    "model-101",
  ])
  view.setCustomCodexModels(true)
  for (const model of models) view.toggleCodexModel(model.id, true)
  expect(view.settings.codexModelIds).toHaveLength(100)
  view.toggleCodexModel("model-0", true)
  expect(view.settings.codexModelIds).toHaveLength(100)
  view.moveCodexModel(99, 1)
  view.moveCodexModel(0, -1)
  view.moveCodexModel(0, 1)
  expect(view.settings.codexModelIds!.slice(0, 2)).toEqual([
    "model-1",
    "model-0",
  ])
  view.toggleCodexModel("model-99", false)
  view.toggleCodexModel("model-101", true)
  view.useRecommended()
  expect(view.settings.codexModelIds).toHaveLength(100)
  await view.save()
  expect(submitted?.codexModelIds?.at(-1)).toBe("model-101")
  expect(view.saved).toBe(true)
  view.setCustomCodexModels(false)
  await view.save()
  expect(submitted?.codexModelIds).toBeNull()
})

test("system settings render translated labels and titles in English", () => {
  const source = readFileSync("pages/js/i18n.js", "utf8")
  const translations = runInNewContext(source + "\ni18n.translations", {
    navigator: { language: "en" },
    localStorage: { getItem: () => null },
  }) as Record<string, Record<string, string>>
  const page = readFileSync("pages/partials/system-config.html", "utf8")
  const t = (key: string) => {
    const value = translations.en[key]
    if (!value) throw new Error(`Missing English translation: ${key}`)
    return value
  }
  const defaultBadge = page.match(
    /x-text="(settings\.codexModelIds !== null[^"]*)"/,
  )?.[1]
  expect(defaultBadge).toBeDefined()
  expect(
    String(
      runInNewContext(defaultBadge!, { t, settings: { codexModelIds: null } }),
    ),
  ).not.toMatch(/[\u3400-\u9fff]/)
  const rendered = page
    .replace(/x-text="([^"]*)"[^>]*>([^<]*)/g, (_match, expression: string) => {
      const value: unknown =
        expression.includes("t(") ?
          runInNewContext(expression, {
            t,
            settings: { codexModelIds: [] },
            source: "webui",
            rule: "secrets",
          })
        : ""
      return `>${String(value)}`
    })
    .replace(
      /:title="([^"]*)"/g,
      (_match, expression: string) =>
        `title="${String(runInNewContext(expression, { t }))}"`,
    )
  const visibleText = rendered
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
  expect(visibleText).not.toMatch(/[\u3400-\u9fff]/)
  expect(rendered.match(/(?<!:)title="[^"]*"/g)?.join(" ") ?? "").not.toMatch(
    /[\u3400-\u9fff]/,
  )
})
