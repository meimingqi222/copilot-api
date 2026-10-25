import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import type { z } from "zod"
import type { redactionConfigSchema } from "~/lib/redaction/rules"
import { getSystemConfig, initializeSystemConfig } from "~/lib/system-config"
import { systemConfigApiRoutes } from "~/routes/admin/api/system-config"

afterEach(() => {
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
})

test("system settings display MiB and save the selected storage budget", async () => {
  const settings = {
    logRetentionDays: 7,
    logMaxTotalBytes: 1024 ** 3,
    concurrencyQueueLimit: 100,
    concurrencyQueueWaitSeconds: 30,
    accountWarmup: {
      enabled: false,
      times: ["07:00"],
      timeZone: "Asia/Shanghai",
      models: {
        claude: "",
        codex: "",
        antigravityGemini: "",
        antigravityClaude: "",
      },
    },
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
  let submitted:
    | {
        logRetentionDays: number
        logMaxTotalBytes: number
        concurrencyQueueLimit: number
        concurrencyQueueWaitSeconds: number
        accountWarmup: typeof settings.accountWarmup
        redaction: typeof settings.redaction
      }
    | undefined
  const source = readFileSync("pages/js/views/system-config.js", "utf8")
  const view = runInNewContext(source + "\nsystemConfigView()", {
    CustomEvent: class {},
    I18n: { currentLang: () => "en" },
    dispatchEvent: () => {},
    API: {
      request: (_path: string, options: { body: typeof settings }) => {
        submitted = options.body
        return Promise.resolve({
          settings: { ...options.body, redaction: originalRedaction },
          source: "webui",
          expiresAt: null,
        })
      },
    },
  }) as {
    settings: typeof settings
    warmupTimesText: string
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
  view.settings.accountWarmup.enabled = true
  view.settings.accountWarmup.models.codex = "gpt-6-luna"
  view.warmupTimesText = "06:30，11:30, 16:30"
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
  expect(submitted?.accountWarmup).toEqual({
    enabled: true,
    times: ["06:30", "11:30", "16:30"],
    timeZone: "Asia/Shanghai",
    models: {
      claude: "",
      codex: "gpt-6-luna",
      antigravityGemini: "",
      antigravityClaude: "",
    },
  })
  expect(submitted?.redaction).toBeUndefined()
  expect(view.saved).toBe(true)
  view.useRecommended()
  expect(view.maxLogMiB).toBe(1024)
  expect(view.settings.concurrencyQueueLimit).toBe(100)
  expect(view.settings.concurrencyQueueWaitSeconds).toBe(30)
  expect(view.settings.accountWarmup.enabled).toBe(false)
  expect(view.settings.logRetentionDays).toBe(7)
  expect(view.settings.redaction).toEqual(originalRedaction)
  view.settings.redaction.enabled = false
  await view.save()
  expect(submitted?.redaction).toBeUndefined()
})

test("redaction editors save literal lines through the API and retain invalid drafts without changing stored rules", async () => {
  let stored: string | undefined
  initializeSystemConfig({
    save: (value) => {
      stored = value
    },
    onChange: () => {},
  })
  const source = readFileSync("pages/js/views/redaction.js", "utf8")
  const view = runInNewContext(source + "\nredactionView()", {
    CustomEvent: class {},
    I18n: { currentLang: () => "en" },
    dispatchEvent: () => {},
    API: {
      async request(_path: string, options: { body: unknown }) {
        expect(_path).toBe("/system-config/redaction-config")
        const response = await systemConfigApiRoutes.request(
          "/redaction-config",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options.body),
          },
        )
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
  }
  try {
    view.accept(getSystemConfig())
    view.settings.redaction.enabled = false
    view.settings.redaction.wordsEnabled = false
    view.settings.redaction.homePaths = false
    view.redactionWordsText = "  private.example \r\n\nfoo.*bar\nhost,part\n"
    view.redactionHomePrefixesText = " /srv/private-user \nC:\\Users\\Private\n"
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
    AbortController,
    CustomEvent: class {},
    I18n: { currentLang: () => "en" },
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

test("warmup time zone search preserves saved IANA names, supports city and offset lookup, and saves explicit choices", async () => {
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  let epoch = Date.parse("2026-01-15T12:00:00Z")
  const view = runInNewContext(
    readFileSync("pages/js/views/system-config.js", "utf8")
      + "\nsystemConfigView()",
    {
      CustomEvent: class {},
      dispatchEvent: () => {},
      I18n: { currentLang: () => "zh" },
      Date: class extends Date {
        constructor() {
          super(epoch)
        }
      },
      API: {
        async request(_path: string, options: { body: unknown }) {
          const response = await systemConfigApiRoutes.request("/", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options.body),
          })
          if (!response.ok) throw new Error(await response.text())
          return response.json()
        },
      },
    },
  ) as {
    settings: ReturnType<typeof getSystemConfig>["settings"]
    warmupTimeZoneSearch: string
    warmupTimeZoneLabel: string
    filteredWarmupTimeZones: Array<{ id: string; offset: string }>
    accept: (config: unknown) => void
    openWarmupTimeZone: () => void
    selectWarmupTimeZone: (id: string) => void
    useLocalWarmupTimeZone: () => void
    save: () => Promise<void>
    $refs: Record<string, { focus: () => void }>
    $nextTick: (callback: () => void) => void
  }
  view.$refs = {
    warmupTimeZoneTrigger: { focus: () => {} },
    warmupTimeZoneSearch: { focus: () => {} },
  }
  view.$nextTick = (callback) => callback()
  view.accept(getSystemConfig())
  view.settings.accountWarmup.timeZone = "Asia/Calcutta"
  view.openWarmupTimeZone()
  expect(view.settings.accountWarmup.timeZone).toBe("Asia/Calcutta")
  expect(view.filteredWarmupTimeZones[0].id).toBe("Asia/Calcutta")
  for (const query of ["北京", "Shanghai", "Asia/Shanghai", "UTC+8"]) {
    view.warmupTimeZoneSearch = query
    expect(view.filteredWarmupTimeZones.map((zone) => zone.id)).toContain(
      "Asia/Shanghai",
    )
  }
  view.warmupTimeZoneSearch = "UTC+05:30"
  expect(view.filteredWarmupTimeZones.map((zone) => zone.id)).toContain(
    "Asia/Calcutta",
  )
  view.warmupTimeZoneSearch = "not-a-timezone"
  expect(view.filteredWarmupTimeZones).toHaveLength(0)
  expect(view.settings.accountWarmup.timeZone).toBe("Asia/Calcutta")
  view.selectWarmupTimeZone("America/New_York")
  expect(view.warmupTimeZoneLabel).toContain("UTC-05:00")
  epoch = Date.parse("2026-07-15T12:00:00Z")
  view.openWarmupTimeZone()
  expect(view.warmupTimeZoneLabel).toContain("UTC-04:00")
  await view.save()
  expect(getSystemConfig().settings.accountWarmup.timeZone).toBe(
    "America/New_York",
  )
  view.useLocalWarmupTimeZone()
  expect(view.settings.accountWarmup.timeZone).toBe(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  )
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
            previewError: "",
            redactionStatsError: "",
            source: "webui",
            rule: "secrets",
            pool: "antigravityClaude",
            zcodeBrowser: { state: "ready" },
            zcodeBrowserDownloadText: () => "",
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

// The page sends a draft; the server schema fills fields it leaves out.
type RedactionDraft = z.input<typeof redactionConfigSchema>
interface PreviewOptions<
  Body = { text: string; format: string; config: RedactionDraft },
> {
  method?: string
  signal?: AbortSignal
  cache?: string
  body?: Body
}
const previewDiagnostics = {
  total: 2,
  byKind: { SECRET: 1, HOME: 1, WORD: 0 },
  bySource: { builtin: 1, word: 0, homePrefix: 1, field: 0, known: 0 },
  maskingMs: 0.25,
  restored: 0,
}
interface RedactionPreviewView {
  detailDetectionSummary: string
  detailMaskingSummary: string
  settings: { redaction: RedactionDraft }
  redactionWordsText: string
  redactionHomePrefixesText: string
  previewText: string
  previewFormat: string
  previewResult: {
    output: string
    enabled: boolean
    diagnostics: typeof previewDiagnostics
  } | null
  previewError: string
  previewLoading: boolean
  previewStale: boolean
  redactionStats: Array<
    typeof previewDiagnostics & {
      id: number
      timestamp: number
      client: string
      upstreams: Array<{
        id: string
        name: string
        protocol: string
        model: string
      }>
      contentAvailable: boolean
      status?: string
    }
  >
  redactionStatsTotal: number
  redactionStatsError: string
  redactionStatsLoading: boolean
  liveActive: boolean
  motionPaused: boolean
  tab: string
  clientFilter: string | null
  upstreamFilter: string | null
  filteredRecords: RedactionPreviewView["redactionStats"]
  inspection: { enabled: boolean; expiresAt: number | null }
  detailId: number | null
  detail: {
    id: number
    input: string | null
    attempts: Array<{
      body: string
      stage: string
      truncated: boolean
      parts?: Array<{ changed: boolean; text?: string; excerpt?: boolean }>
    }>
    mappings: Array<{ placeholder: string; value?: string }>
    truncated: boolean
  } | null
  detailRevealed: boolean
  detailViewMode: string
  contentParts(
    body: string,
    mappings: Array<{ placeholder: string }>,
    excerpts?: Array<{ path: string; text: string }>,
  ): Array<{
    changed: boolean
    excerpt?: boolean
    path?: string
    role?: string
    text?: string
    leaves?: Array<{ path: string; text: string }>
  }>
  excerptSegments(
    text: string,
    whole?: boolean,
    original?: boolean,
  ): Array<{ text: string; kind: string }>
  detailLoading: boolean
  detailError: string
  acceptInspection(value: unknown): void
  loadDetail(id: number, reveal?: boolean): Promise<void>
  clearDetail(): void
  changeInspection(action: string): Promise<void>
  filterRoute(side: string, id: string): void
  routeGroups(side: string): Array<{ id: string; name: string; count: number }>
  syncLive(): void
  kindTotal(kind: string): number
  init(): void
  runRedactionPreview(): Promise<void>
  clearPreview(): void
  samplePreview(): void
  destroy(): void
  leaveRedaction(): void
  loadRedactionStats(background?: boolean): Promise<void>
  draftRedactionConfig(): RedactionDraft
  redactionCounts(counts: Record<string, number>, group: string): string
  formatUpstreams(entry: {
    upstreams: Array<{ id: string; name: string }>
  }): string
}

function redactionView(
  request: (path: string, options: PreviewOptions) => Promise<unknown>,
  runtime: Record<string, unknown> = {},
) {
  const watchers = new Map<string, () => void>()
  const view = runInNewContext(
    readFileSync("pages/js/views/redaction.js", "utf8") + "\nredactionView()",
    {
      AbortController,
      API: {
        // The day-strip history is its own endpoint; tests here count the
        // stats, preview and inspection calls, so answer it out of band.
        request: (path: string, options: PreviewOptions) =>
          path.startsWith("/system-config/redaction-history") ?
            Promise.resolve({ days: [], requests: 0, total: 0 })
          : request(path, options),
      },
      I18n: { t: (key: string) => key },
      setTimeout: () => 1,
      clearTimeout: () => {},
      ...runtime,
    },
  ) as RedactionPreviewView & {
    $watch: (key: string, callback: () => void) => void
    $nextTick: (callback: () => void) => void
  }
  view.$watch = (key, callback) => {
    watchers.set(key, callback)
  }
  // Alpine supplies $nextTick; the flow map it schedules needs a DOM.
  view.$nextTick = () => {}
  view.settings = {
    redaction: structuredClone(getSystemConfig().settings.redaction),
  }
  view.init()
  return { view, watchers }
}

test("redaction preview submits unsaved complete rules only explicitly, supports disabled unchanged output and clears without saving", async () => {
  const calls: Array<{ path: string; options: PreviewOptions }> = []
  const { view } = redactionView(async (path, options) => {
    calls.push({ path, options })
    return {
      output: options.body!.text,
      enabled: options.body!.config.enabled,
      diagnostics: {
        total: 0,
        byKind: { SECRET: 0, HOME: 0, WORD: 0 },
        bySource: { builtin: 0, word: 0, homePrefix: 0, field: 0, known: 0 },
        maskingMs: 0,
        restored: 0,
      },
    }
  })
  view.settings.redaction = {
    enabled: false,
    secrets: false,
    homePaths: true,
    wordsEnabled: true,
    words: ["saved"],
    homePrefixes: [],
  }
  const original = JSON.stringify(view.settings)
  view.redactionWordsText = " draft.word \r\n\nsecond.word\n"
  view.redactionHomePrefixesText = " /srv/synthetic \n"
  view.previewFormat = "json"
  // The sample button is an explicit action and its text is synthetic, so it
  // previews at once; typed text still waits for the Preview button.
  view.samplePreview()
  expect(JSON.parse(view.previewText).password).toBe(
    ["synthetic", "demo", "password123"].join("-"),
  )
  expect(calls).toHaveLength(1)
  expect(calls[0].options.body?.text).toBe(view.previewText)
  await view.runRedactionPreview()
  expect(calls[1].path).toBe("/system-config/redaction-preview")
  expect(calls[1].options.method).toBe("POST")
  expect(calls[1].options.body?.config).toEqual({
    enabled: false,
    secrets: false,
    homePaths: true,
    wordsEnabled: true,
    words: ["draft.word", "second.word"],
    homePrefixes: ["/srv/synthetic"],
    allow: [],
  })
  expect(view.previewResult?.enabled).toBe(false)
  expect(view.previewResult?.output).toBe(view.previewText)
  expect(view.previewResult?.diagnostics.total).toBe(0)
  view.clearPreview()
  expect(view.previewText).toBe("")
  expect(view.previewResult).toBeNull()
  expect(view.previewError).toBe("")
  expect(view.previewStale).toBe(false)
  expect(JSON.stringify(view.settings)).toBe(original)
  expect(view.redactionWordsText).toContain("draft.word")
  expect(calls).toHaveLength(2)
})

test("preview errors never echo server text and oversized or empty input never submits", async () => {
  let requests = 0
  const { view } = redactionView(async () => {
    requests++
    throw new Error("sensitive echoed input")
  })
  view.previewText = "{ invalid json"
  view.previewFormat = "json"
  await view.runRedactionPreview()
  expect(view.previewError).toBe("system.redaction.previewError")
  expect(view.previewLoading).toBe(false)
  expect(view.previewResult).toBeNull()
  view.previewText = "x".repeat(65537)
  await view.runRedactionPreview()
  expect(view.previewError).toBe("system.redaction.previewTooLarge")
  view.clearPreview()
  await view.runRedactionPreview()
  expect(requests).toBe(1)
})

test("preview watchers abort and invalidate responses on edits, clear, navigation and destroy", async () => {
  for (const change of [
    "previewText",
    "previewFormat",
    "settings",
    "redactionWordsText",
    "redactionHomePrefixesText",
    "clear",
    "leave",
    "destroy",
  ]) {
    let finish!: (value: unknown) => void
    let signal: AbortSignal | undefined
    const { view, watchers } = redactionView((_path, options) => {
      signal = options.signal
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    view.previewText = "sensitive draft"
    const pending = view.runRedactionPreview()
    expect(view.previewLoading).toBe(true)
    if (change === "clear") view.clearPreview()
    else if (change === "leave") view.leaveRedaction()
    else if (change === "destroy") view.destroy()
    else watchers.get(change)!()
    expect(signal?.aborted).toBe(true)
    finish({
      output: "stale output",
      enabled: true,
      diagnostics: previewDiagnostics,
    })
    await pending
    expect(view.previewResult).toBeNull()
    expect(view.previewLoading).toBe(false)
    if (["clear", "leave", "destroy"].includes(change))
      expect(view.previewText).toBe("")
    else expect(view.previewStale).toBe(true)
  }
})

test("preview snapshot also rejects a changed draft even before watch callbacks run", async () => {
  let finish!: (value: unknown) => void
  const { view } = redactionView(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  view.previewText = "first"
  const pending = view.runRedactionPreview()
  view.redactionWordsText = "changed"
  finish({ output: "old", enabled: true, diagnostics: previewDiagnostics })
  await pending
  expect(view.previewResult).toBeNull()
})

test("a late preview cannot replace a newer successful preview or retain output after editing", async () => {
  const completions: Array<(value: unknown) => void> = []
  const { view, watchers } = redactionView(
    () =>
      new Promise((resolve) => {
        completions.push(resolve)
      }),
  )
  view.settings.redaction.enabled = true
  view.previewText = "first"
  const first = view.runRedactionPreview()
  view.previewText = "second"
  watchers.get("previewText")!()
  const second = view.runRedactionPreview()
  completions[1]({
    output: "<script>masked</script>",
    enabled: true,
    diagnostics: previewDiagnostics,
  })
  await second
  expect(view.previewResult?.output).toBe("<script>masked</script>")
  expect(view.previewResult?.diagnostics).toEqual(previewDiagnostics)
  completions[0]({
    output: "obsolete",
    enabled: true,
    diagnostics: previewDiagnostics,
  })
  await first
  expect(view.previewResult?.output).toBe("<script>masked</script>")
  watchers.get("redactionWordsText")!()
  expect(view.previewResult).toBeNull()
  expect(view.previewStale).toBe(true)
})

test("recent diagnostics retain only metadata, aggregate unique values and ignore responses after leaving", async () => {
  const { view } = redactionView(async (path) => {
    expect(path).toBe("/system-config/redaction-stats")
    return {
      limit: 100,
      entries: [
        {
          ...previewDiagnostics,
          id: 2,
          timestamp: 100,
          payload: "must not retain",
          byKind: { ...previewDiagnostics.byKind, identity: "must not retain" },
        },
        { ...previewDiagnostics, id: 1, timestamp: 90 },
      ],
    }
  })
  await view.loadRedactionStats()
  expect(view.redactionStats).toHaveLength(2)
  expect(view.redactionStatsTotal).toBe(4)
  expect(view.kindTotal("SECRET")).toBe(2)
  expect(JSON.stringify(view.redactionStats)).not.toContain("must not retain")
  expect(view.redactionCounts(view.redactionStats[0].byKind, "kind")).toContain(
    "system.redaction.SECRET: 1",
  )
  let finish!: (value: unknown) => void
  const delayed = redactionView(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = delayed.view.loadRedactionStats()
  delayed.view.leaveRedaction()
  finish({ entries: [{ ...previewDiagnostics, id: 1, timestamp: 90 }] })
  await pending
  expect(delayed.view.redactionStats).toHaveLength(0)
  expect(delayed.view.redactionStatsLoading).toBe(false)
  const failed = redactionView(async () => {
    throw new Error("private upstream failure")
  })
  await failed.view.loadRedactionStats()
  expect(failed.view.redactionStatsError).toBe("system.redaction.statsError")
})

test("live redaction diagnostics keep the last snapshot on failures and stop while hidden or after navigation", async () => {
  const document = { hidden: false }
  const timers = new Map<number, () => Promise<void>>()
  let timerId = 0
  let fail = false
  const { view } = redactionView(
    async () => {
      if (fail) throw new Error("temporary failure")
      return { entries: [{ ...previewDiagnostics, id: 7, timestamp: 100 }] }
    },
    {
      document,
      setTimeout: (callback: () => Promise<void>, delay: number) => {
        expect(delay).toBe(2500)
        timers.set(++timerId, callback)
        return timerId
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  )
  view.liveActive = true
  view.syncLive()
  const tick = async () => {
    const [id, callback] = [...timers][0]
    timers.delete(id)
    await callback()
  }
  await tick()
  expect(view.redactionStatsTotal).toBe(2)
  fail = true
  await tick()
  expect(view.redactionStatsTotal).toBe(2)
  expect(view.redactionStatsError).toBe("system.redaction.statsError")
  document.hidden = true
  view.syncLive()
  expect(timers.size).toBe(0)
  expect(view.motionPaused).toBe(true)
  document.hidden = false
  view.syncLive()
  expect(timers.size).toBe(1)
  expect(view.motionPaused).toBe(false)
  view.leaveRedaction()
  expect(timers.size).toBe(0)
  expect(view.motionPaused).toBe(true)
  view.syncLive()
  expect(timers.size).toBe(0)
})

test("live redaction events coalesce refreshes, retain in-flight changes and close on hide or leave", async () => {
  const document = { hidden: false }
  const timers = new Map<
    number,
    { callback: () => Promise<void>; delay: number }
  >()
  const sources: FakeSource[] = []
  let timerId = 0
  let finish!: (value: unknown) => void
  let calls = 0
  class FakeSource {
    closed = false
    change = () => {}
    url: string
    constructor(url: string) {
      this.url = url
      sources.push(this)
    }
    addEventListener(event: string, callback: () => void) {
      expect(event).toBe("change")
      this.change = callback
    }
    close() {
      this.closed = true
    }
  }
  const { view } = redactionView(
    () => {
      calls++
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    {
      document,
      EventSource: FakeSource,
      setTimeout: (callback: () => Promise<void>, delay: number) => {
        timers.set(++timerId, { callback, delay })
        return timerId
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  )
  view.liveActive = true
  view.syncLive()
  expect(sources).toHaveLength(1)
  expect(sources[0].url).toEndWith("/system-config/redaction-events")
  sources[0].change()
  sources[0].change()
  expect(
    [...timers.values()].filter((timer) => timer.delay === 50),
  ).toHaveLength(1)
  const [id, timer] = [...timers].find(([, item]) => item.delay === 50)!
  timers.delete(id)
  const pending = timer.callback()
  expect(calls).toBe(1)
  sources[0].change()
  finish({
    entries: [
      { ...previewDiagnostics, id: 1, timestamp: 100, status: "in_progress" },
    ],
  })
  await pending
  expect([...timers.values()].filter((item) => item.delay === 50)).toHaveLength(
    1,
  )
  document.hidden = true
  view.syncLive()
  expect(sources[0].closed).toBe(true)
  expect(timers.size).toBe(0)
  sources[0].change()
  expect(timers.size).toBe(0)
  document.hidden = false
  view.syncLive()
  expect(sources).toHaveLength(2)
  view.leaveRedaction()
  expect(sources[1].closed).toBe(true)
  expect(timers.size).toBe(0)
})

test("redaction flow animates delayed routes and failover once without replaying completed history", () => {
  type FlowEntry = {
    id: number
    status: string
    upstreams: Array<{ id: string }>
  }
  const document = { hidden: false }
  const view = runInNewContext(
    readFileSync("pages/js/views/redaction.js", "utf8") + "\nredactionView()",
    {
      document,
      window: { matchMedia: () => ({ matches: false }) },
    },
  ) as {
    redactionStats: FlowEntry[]
    emitFlow(): void
    playRecordFlow(entry: FlowEntry): void
  }
  const played: FlowEntry[] = []
  view.playRecordFlow = (entry) => {
    played.push(entry)
  }
  const history: FlowEntry = {
    id: 1,
    status: "completed",
    upstreams: [{ id: "old" }],
  }
  view.redactionStats = [history]
  view.emitFlow()
  expect(played).toHaveLength(0)
  const slow: FlowEntry = { id: 2, status: "in_progress", upstreams: [] }
  view.redactionStats = [slow, history]
  view.emitFlow()
  expect(played).toHaveLength(0)
  const newer: FlowEntry = {
    id: 3,
    status: "in_progress",
    upstreams: [{ id: "fast" }],
  }
  view.redactionStats = [newer, slow, history]
  view.emitFlow()
  slow.upstreams.push({ id: "slow" })
  view.emitFlow()
  slow.status = "completed"
  view.emitFlow()
  expect(played.map((entry) => entry.id)).toEqual([3, 2])
  newer.upstreams.push({ id: "retry" })
  view.emitFlow()
  expect(played.at(-1)?.upstreams).toEqual([{ id: "retry" }])
  view.emitFlow()
  expect(played).toHaveLength(3)
})

test("recent redaction rows render actual upstream names with a safe empty fallback", () => {
  const { view } = redactionView(async () => ({}))
  expect(
    view.formatUpstreams({
      upstreams: [
        { id: "a", name: "Provider A" },
        { id: "b", name: "" },
      ],
    }),
  ).toBe("Provider A、b")
  expect(view.formatUpstreams({ upstreams: [] })).toBe(
    "redaction.routes.unknown",
  )
})

test("preview markup renders output as text, is labeled, and exposes translated privacy and count semantics", () => {
  const page = readFileSync("pages/partials/redaction.html", "utf8")
  expect(page).toContain('x-text="previewResult?.output"')
  expect(page).not.toContain("x-html")
  expect(page).toContain('aria-describedby="redaction-preview-hint"')
  expect(page).toContain("else leaveRedaction()")
  const translations = runInNewContext(
    readFileSync("pages/js/i18n.js", "utf8") + "\ni18n.translations",
    { navigator: { language: "en" }, localStorage: { getItem: () => null } },
  ) as Record<string, Record<string, string>>
  for (const match of page.matchAll(/t\('(system\.redaction\.[^']+)'\)/g)) {
    expect(translations.en[match[1]]).toBeTruthy()
    expect(translations.zh[match[1]]).toBeTruthy()
  }
  expect(translations.en["system.redaction.countHint"]).toContain(
    "not occurrences",
  )
  expect(translations.en["system.redaction.statsHint"]).toContain(
    "resets on restart",
  )
})

test("redaction has its own authenticated navigation and lazy page, not a second settings editor", () => {
  const app = runInNewContext(
    readFileSync("pages/js/views/app.js", "utf8") + "\nadminApp()",
    { I18n: { currentLang: () => "en", t: (key: string) => key } },
  ) as {
    resolveHashView(hash: string): { view: string; canonical: string }
    navGroups: Array<{ id: string; items: Array<{ id: string }> }>
  }
  expect(app.resolveHashView("redaction")).toEqual({
    view: "redaction",
    canonical: "redaction",
  })
  expect(
    app.navGroups
      .find((group) => group.id === "access")
      ?.items.map((item) => item.id),
  ).toContain("redaction")
  const html = readFileSync("pages/index.html", "utf8")
  expect(html).toContain("initialized && visitedViews['redaction']")
  expect(html).toContain('data-partial="partials/redaction.html?v=')
  const settings = readFileSync("pages/partials/system-config.html", "utf8")
  expect(settings).not.toContain('x-model="settings.redaction.enabled"')
  expect(settings).not.toContain('x-model="previewText"')
})

const inspectionState = () => ({
  enabled: true,
  expiresAt: Date.now() + 300000,
  ttlMs: 300000,
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 128 * 1024,
  bytes: 100,
})
const upstream = {
  id: "real-id",
  name: "Actual upstream",
  protocol: "responses",
  model: "real-model",
}
const capturedEntry = (id = 1) => ({
  ...previewDiagnostics,
  id,
  timestamp: 100,
  client: "Claude Code",
  upstreams: [upstream],
  contentAvailable: true,
})
const capturedDetail = () => ({
  id: 1,
  input: "original secret",
  attempts: [
    {
      upstream,
      stage: "http",
      body: "<script>__SECRET_1__</script>",
      truncated: false,
    },
    {
      upstream: { ...upstream, id: "fallback" },
      stage: "adapter",
      body: "adapter payload",
      truncated: true,
    },
  ],
  mappings: [
    {
      placeholder: "__SECRET_1__",
      kind: "SECRET",
      source: "builtin",
      value: "original secret",
    },
  ],
  truncated: true,
})

test("route endpoints derive only from retained metadata, count request membership, support unknowns and intersecting filters", async () => {
  const { view } = redactionView(async () => ({
    inspection: inspectionState(),
    entries: [
      {
        ...capturedEntry(1),
        upstreams: [
          upstream,
          { ...upstream, model: "second attempt" },
          { ...upstream, id: "fallback" },
        ],
        input: "never keep",
        attempts: capturedDetail().attempts,
      },
      { ...capturedEntry(2), client: "Codex" },
      { ...previewDiagnostics, id: 3, timestamp: 1 },
      ...[4, 5, 6, 7].map((id) => ({
        ...capturedEntry(id),
        client: `client-${id}`,
        upstreams: [{ ...upstream, id: `upstream-${id}` }],
      })),
    ],
  }))
  expect(view.routeGroups("client")).toEqual([])
  await view.loadRedactionStats()
  expect(
    view.routeGroups("upstream").find((item) => item.id === upstream.id)?.count,
  ).toBe(2)
  expect(
    view.routeGroups("upstream").find((item) => item.id === "fallback")?.count,
  ).toBe(1)
  expect(
    view.routeGroups("upstream").find((item) => item.id === "")?.count,
  ).toBe(1)
  expect(view.routeGroups("client")).toHaveLength(7)
  expect(JSON.stringify(view.redactionStats)).not.toContain("never keep")
  expect(JSON.stringify(view.redactionStats)).not.toContain("__SECRET_1__")
  view.filterRoute("upstream", upstream.id)
  expect(view.tab).toBe("overview")
  expect(view.filteredRecords.map((entry) => entry.id)).toEqual([1, 2])
  view.filterRoute("client", "Codex")
  expect(view.filteredRecords.map((entry) => entry.id)).toEqual([2])
  view.filterRoute("client", "Codex")
  view.filterRoute("upstream", upstream.id)
  view.filterRoute("upstream", "")
  expect(view.filteredRecords.map((entry) => entry.id)).toEqual([3])
})

test("content is explicitly fetched without cache; masked view never keeps originals and reveal requests them separately", async () => {
  const calls: Array<{ path: string; options: PreviewOptions }> = []
  const { view } = redactionView(async (path, options) => {
    calls.push({ path, options })
    return path.endsWith("redaction-stats") ?
        { entries: [capturedEntry()], inspection: inspectionState() }
      : capturedDetail()
  })
  expect(view.inspection.enabled).toBe(false)
  await view.loadRedactionStats()
  expect(calls).toHaveLength(1)
  expect(view.detail).toBeNull()
  await view.loadDetail(1)
  expect(calls[1].path).toBe("/system-config/redaction-records/1")
  expect(calls[1].options.cache).toBe("no-store")
  expect(view.detail?.input).toBeNull()
  expect(view.detail?.mappings[0].value).toBeUndefined()
  expect(view.detail?.attempts.map((attempt) => attempt.stage)).toEqual([
    "http",
    "adapter",
  ])
  expect(view.detail?.attempts[0].body).toBe("<script>__SECRET_1__</script>")
  expect(view.detail?.truncated).toBe(true)
  await view.loadDetail(1, true)
  expect(calls[2].path).toBe("/system-config/redaction-records/1?reveal=1")
  expect(view.detailRevealed).toBe(true)
  expect(view.detail?.input).toBeNull()
  expect(view.detail?.mappings[0].value).toBe("original secret")
  await view.loadDetail(1)
  expect(JSON.stringify(view.detail)).not.toContain("original secret")
  expect(JSON.stringify(view.redactionStats)).not.toContain("original secret")
})

test("capture enable, disable and clear use ephemeral endpoints and preserve metadata", async () => {
  const calls: Array<{ path: string; options: PreviewOptions<unknown> }> = []
  const { view } = redactionView(async (path, options) => {
    calls.push({ path, options })
    if (path.endsWith("redaction-stats"))
      return { entries: [capturedEntry()], inspection: inspectionState() }
    return {
      inspection: {
        ...inspectionState(),
        enabled: !JSON.stringify(options.body ?? {}).includes("false"),
      },
    }
  })
  await view.loadRedactionStats()
  await view.changeInspection("enable")
  expect(calls[1].path).toBe("/system-config/redaction-inspection")
  expect(calls[1].options.method).toBe("POST")
  expect(calls[1].options.body).toEqual({ enabled: true })
  await view.changeInspection("disable")
  expect(calls[2].options.body).toEqual({ enabled: false })
  expect(view.inspection.enabled).toBe(false)
  expect(view.redactionStats).toHaveLength(1)
  expect(view.redactionStats[0].contentAvailable).toBe(false)
  await view.changeInspection("clear")
  expect(calls[3].path).toBe("/system-config/redaction-records")
  expect(calls[3].options.method).toBe("DELETE")
  expect(calls[3].options.body).toBeUndefined()
  expect(
    calls.slice(1).every((call) => call.options.cache === "no-store"),
  ).toBe(true)
  expect(view.redactionStats).toHaveLength(1)
})

test("late content cannot survive close, ID changes, filters, hide, TTL, disable, clear, eviction, navigation or destroy", async () => {
  for (const action of [
    "close",
    "id",
    "filter",
    "hide",
    "ttl",
    "disable",
    "clear",
    "off",
    "evicted",
    "leave",
    "destroy",
  ]) {
    let finish!: (value: unknown) => void
    let signal: AbortSignal | undefined
    let timer: (() => void) | undefined
    let available = true
    let enabled = true
    const { view } = redactionView(
      async (path, options) => {
        if (path.endsWith("redaction-stats"))
          return {
            entries: [
              { ...capturedEntry(), contentAvailable: available },
              capturedEntry(2),
            ],
            inspection: { ...inspectionState(), enabled },
          }
        if (options.method)
          return { inspection: { ...inspectionState(), enabled: false } }
        if (path.endsWith("/2")) return { ...capturedDetail(), id: 2 }
        signal = options.signal
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      {
        document: { hidden: true },
        setTimeout: (callback: () => void) => {
          timer = callback
          return 1
        },
      },
    )
    await view.loadRedactionStats()
    const pending = view.loadDetail(1, true)
    const firstSignal = signal
    if (action === "close") view.clearDetail()
    else if (action === "id") await view.loadDetail(2)
    else if (action === "filter") view.filterRoute("client", "Claude Code")
    else if (action === "hide") view.syncLive()
    else if (action === "ttl") timer!()
    else if (action === "disable" || action === "clear")
      await view.changeInspection(action)
    else if (action === "off" || action === "evicted") {
      enabled = action !== "off"
      available = action !== "evicted"
      await view.loadRedactionStats()
    } else if (action === "leave") view.leaveRedaction()
    else view.destroy()
    expect(firstSignal?.aborted).toBe(true)
    finish(capturedDetail())
    await pending
    if (action === "id") expect(view.detail?.id).toBe(2)
    else expect(view.detail).toBeNull()
    expect(view.detailLoading).toBe(false)
  }
})

test("content failures are generic and expired records never trigger a fetch", async () => {
  let calls = 0
  const { view } = redactionView(async (path) => {
    calls++
    if (path.endsWith("redaction-stats"))
      return { entries: [capturedEntry()], inspection: inspectionState() }
    throw new Error("private upstream body")
  })
  await view.loadRedactionStats()
  await view.loadDetail(1, true)
  expect(view.detailError).toBe("redaction.inspect.error")
  expect(view.detail).toBeNull()
  view.acceptInspection({ enabled: true, expiresAt: Date.now() - 1 })
  await view.loadDetail(1)
  expect(calls).toBe(2)
})

test("request excerpts focus known matches, merge nearby windows and reveal only by explicit request", async () => {
  const a = `{{SECRET_${"a".repeat(32)}}}`
  const b = `{{HOME_${"b".repeat(32)}}}`
  const literal = `{{WORD_${"c".repeat(32)}}}`
  const calls: Array<string> = []
  const { view } = redactionView(async (path) => {
    calls.push(path)
    return {
      ...capturedDetail(),
      mappings: [
        {
          placeholder: a,
          kind: "SECRET",
          source: "builtin",
          value: "<img src=x onerror=alert(1)>",
        },
        {
          placeholder: b,
          kind: "HOME",
          source: "builtin",
          value: "synthetic-original",
        },
      ],
    }
  })
  view.redactionStats = [capturedEntry()]
  view.acceptInspection(inspectionState())
  await view.loadDetail(1)
  const text = "a".repeat(180) + a + "b".repeat(260) + b + "c".repeat(450)
  expect(
    view
      .excerptSegments(text)
      .map((x) => x.text)
      .join(""),
  ).toBe(
    "…" + "a".repeat(120) + a + "b".repeat(260) + b + "c".repeat(120) + "…",
  )
  const apart = text.replace("b".repeat(260), "b".repeat(261))
  expect(
    view
      .excerptSegments(apart)
      .map((x) => x.text)
      .join(""),
  ).toBe(
    "…"
      + "a".repeat(120)
      + a
      + "b".repeat(120)
      + "…"
      + "b".repeat(120)
      + b
      + "c".repeat(120)
      + "…",
  )
  const short = "字".repeat(280) + a + "尾".repeat(277)
  expect(short.length).toBe(600)
  expect(
    view
      .excerptSegments(short)
      .map((x) => x.text)
      .join(""),
  ).toBe(short)
  expect(
    view
      .excerptSegments(short + "尾")
      .map((x) => x.text)
      .join(""),
  ).toBe("…" + "字".repeat(120) + a + "尾".repeat(120) + "…")
  expect(
    view
      .excerptSegments(apart, true)
      .map((x) => x.text)
      .join(""),
  ).toBe(apart)
  expect(
    view
      .excerptSegments(literal + a)
      .filter((x) => x.kind)
      .map((x) => x.text),
  ).toEqual([a])
  expect(view.excerptSegments(a, false, true)[0].text).toBe(a)
  expect(calls).toHaveLength(1)
  await view.loadDetail(1, true)
  expect(view.detailRevealed).toBe(true)
  expect(view.detailViewMode).toBe("both")
  expect(view.excerptSegments(a, false, true)[0].text).toBe(
    "<img src=x onerror=alert(1)>",
  )
  expect(calls[1]).toEndWith("?reveal=1")
  view.clearDetail()
  // Closing forgets the reveal: reopening shows placeholders only.
  expect(view.detailRevealed).toBe(false)
  expect(view.excerptSegments(a, false, true)[0].text).toBe(a)
  expect(view.excerptSegments(a).some((x) => x.kind)).toBe(false)
})

test("request content keeps JSON locations and roles, folds unchanged parts and tolerates truncated wire", () => {
  const token = `{{HOME_${"a".repeat(32)}}}`
  const { view } = redactionView(async () => ({}))
  const parts = view.contentParts(
    JSON.stringify({
      model: "native",
      messages: [
        { role: "system", content: "unchanged instructions" },
        { role: "user", content: [{ type: "text", text: `Run ${token}/src` }] },
      ],
      "a.b": token,
    }),
    [{ placeholder: token }],
  )
  expect(
    parts
      .filter((part) => part.changed)
      .map(({ path, role, text }) => ({ path, role, text })),
  ).toEqual([
    {
      path: "$.messages[1].content[0].text",
      role: "user",
      text: `Run ${token}/src`,
    },
    { path: '$["a.b"]', role: "", text: token },
  ])
  expect(parts[0].changed).toBe(false)
  expect(
    parts[0].leaves?.some((leaf) => leaf.text === "unchanged instructions"),
  ).toBe(true)
  expect(
    view.contentParts(`truncated ${token} {`, [{ placeholder: token }]),
  ).toEqual([
    { path: "$", role: "", text: `truncated ${token} {`, changed: true },
  ])
  expect(view.contentParts(token, []).every((part) => !part.changed)).toBe(true)
})

test("detail loads independent match excerpts when the retained wire prefix has no matches", async () => {
  const token = `{{HOME_${"a".repeat(32)}}}`
  const { view } = redactionView(async () => ({
    id: 1,
    input: null,
    truncated: true,
    mappings: [
      { placeholder: token, kind: "HOME", label: "HOME", source: "builtin" },
    ],
    attempts: [
      {
        upstream: {
          id: "fixture",
          name: "Fixture",
          protocol: "codex-native",
          model: "fixture",
        },
        stage: "http",
        body: "retained instructions prefix",
        truncated: true,
        excerpts: [
          { path: "$", text: `…config: ${token}/.codex/config.toml…` },
        ],
      },
    ],
  }))
  view.inspection = { enabled: true, expiresAt: null }
  view.redactionStats = [
    {
      ...previewDiagnostics,
      id: 1,
      timestamp: Date.now(),
      client: "Codex",
      upstreams: [],
      contentAvailable: true,
    },
  ]
  await view.loadDetail(1)
  const attempt = view.detail!.attempts[0]
  expect(attempt.body).toBe("retained instructions prefix")
  expect(attempt.parts!.filter((part) => part.changed)).toMatchObject([
    { excerpt: true, text: `…config: ${token}/.codex/config.toml…` },
  ])
  expect(view.detailRevealed).toBe(false)
  expect(
    view
      .contentParts(
        token,
        [{ placeholder: token }],
        [{ path: "$", text: token }],
      )
      .filter((part) => part.changed),
  ).toHaveLength(1)
})

test("route and inspection markup is text-only, accessible, translated and honest about observed bodies", () => {
  const page = readFileSync("pages/partials/redaction.html", "utf8")
  expect(page).not.toContain("x-html")
  // Alpine cannot render a <template> inside an SVG element; check each one
  // on its own so the pattern never spans from one element to the next.
  for (const svg of page.matchAll(/<svg\b(?:(?!<\/svg>)[\s\S])*?<\/svg>/g))
    expect(svg[0]).not.toMatch(/<template[^>]*x-for/)
  // Bodies render as text tokens, and only an http-stage body is labeled as
  // what the upstream received.
  expect(page).toContain('x-for="(part, pIndex) in attempt.parts"')
  expect(page).toContain(
    "attempt.stage === 'http' ? 'redaction.inspect.http' : 'redaction.inspect.adapter'",
  )
  expect(page).toContain('x-text="mapping.value"')
  expect(page).toContain('x-for="group in groupedRecords"')
  expect(page).toContain('x-for="item in displayEndpoints.clients"')
  expect(page).toContain('x-for="item in displayEndpoints.upstreams"')
  expect(page).toContain(":aria-pressed=")
  expect(page).toContain("t('redaction.inspect.warning')")
  expect(page).toContain("t('redaction.routes.legend')")
  const translations = runInNewContext(
    readFileSync("pages/js/i18n.js", "utf8") + "\ni18n.translations",
    {
      navigator: { language: "en" },
      localStorage: { getItem: () => null },
    },
  ) as Record<string, Record<string, string>>
  for (const match of page.matchAll(
    /'(redaction\.(?:routes|inspect)\.[^']+)'/g,
  )) {
    for (const lang of ["en", "zh"])
      expect(translations[lang][match[1]]).toBeTruthy()
  }
  expect(translations.en["redaction.inspect.adapter"]).toContain(
    "NOT the final sent wire",
  )
  expect(translations.en["redaction.inspect.warning"]).toContain(
    "undetected secrets",
  )
  expect(translations.en["redaction.routes.legend"]).toContain("User-Agent")
})

test("redaction detail wires focused excerpts, closed unchanged groups and explicit full text into the rendered view", () => {
  const page = readFileSync("pages/partials/redaction.html", "utf8")
  expect(page).not.toContain("partChunks(part)")
  expect(page).toContain("excerptSegments(part.text, whole, true)")
  expect(page).toContain("excerptSegments(part.text, whole)")
  expect(page).toContain('x-if="open"')
  expect(page).toContain("part.leaves.slice(0, 40)")
  expect(page).toContain("leaf.text.slice(0, 400)")
  expect(page).toContain("redaction.inspect.focusHint")
  expect(page).toContain("redaction.inspect.compareHint")
  expect(page).toContain("redaction.inspect.showWhole")
  expect(page).toContain("redaction.inspect.rawBody")
  expect(page).not.toContain("客户端输入视角 (Client Input)")
})

test("detail counters use request diagnostics when truncated captures have no mappings", () => {
  const { view } = redactionView(async () => ({}))
  view.detailId = 1
  view.detail = {
    id: 1,
    input: null,
    attempts: [],
    mappings: [],
    truncated: true,
  }
  view.redactionStats = [
    {
      ...capturedEntry(),
      total: 2,
      byKind: { ...previewDiagnostics.byKind, HOME: 2 },
      status: "completed",
    },
  ]
  expect(view.detailDetectionSummary).toBe("redaction.inspect.detected")
  expect(view.detailMaskingSummary).toBe("redaction.inspect.maskedCount")
  view.redactionStats[0].status = "in_progress"
  expect(view.detailDetectionSummary).toBe("redaction.inspect.detected")
  view.redactionStats = []
  expect(view.detailDetectionSummary).toBe("redaction.inspect.countUnknown")
  const page = readFileSync("pages/partials/redaction.html", "utf8")
  expect(page).toContain('x-for="fact in detailFacts"')
  expect(page).not.toContain("规则扫描完毕 · 0 处命中")
  expect(page).not.toContain("未触发替换 (原文通行)")
})

test("truncated JSON detail shows match context instead of the long prompt prefix and keeps full text opt-in", async () => {
  const token = `{{HOME_${"a".repeat(32)}}}`
  const body =
    '{"messages":[{"role":"user","content":"'
    + "unrelated prompt ".repeat(300)
    + `Read ${token}/project and continue`
    + " tail".repeat(300)
  const { view } = redactionView(async () => ({
    ...capturedDetail(),
    attempts: [{ upstream, stage: "adapter", body, truncated: true }],
    mappings: [
      {
        placeholder: token,
        kind: "HOME",
        source: "builtin",
        value: "/home/fixture-user",
      },
    ],
  }))
  view.redactionStats = [capturedEntry()]
  view.acceptInspection(inspectionState())
  await view.loadDetail(1)
  const [part] = view.contentParts(body, [{ placeholder: token }])
  expect(part.changed).toBe(true)
  const excerpt = view
    .excerptSegments(part.text!)
    .map((segment) => segment.text)
    .join("")
  expect(excerpt.length).toBeLessThan(400)
  expect(excerpt).toContain(`Read ${token}/project`)
  expect(excerpt).not.toContain('{"messages"')
  expect(excerpt).not.toContain("/home/fixture-user")
  expect(
    view
      .excerptSegments(body, true)
      .map((segment) => segment.text)
      .join(""),
  ).toBe(body)
  await view.loadDetail(1, true)
  expect(
    view
      .excerptSegments(body, false, true)
      .map((segment) => segment.text)
      .join(""),
  ).toContain("Read /home/fixture-user/project")
})
