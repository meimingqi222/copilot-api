import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

function fixture(
  request: (url: string) => Promise<unknown> = async () => ({}),
) {
  const view = runInNewContext(
    readFileSync("pages/js/views/redaction.js", "utf8") + "\nredactionView()",
    {
      API: { request },
      AbortController,
      I18n: {
        t: (key: string, values: Record<string, unknown> = {}) =>
          key + JSON.stringify(values),
      },
      setTimeout: () => 1,
      clearTimeout: () => {},
      document: { hidden: false },
    },
  )
  view.$nextTick = () => {}
  view.loadHistory = async () => {}
  return view
}

const entry = (id: number, client = "Codex") => ({
  id,
  timestamp: 100,
  status: "completed",
  client,
  total: 2,
  byKind: { HOME: 2 },
  detected: 2,
  detectedByKind: { HOME: 2 },
  bySource: {},
  warned: 0,
  blocked: 0,
  upstreams: [{ id: "a", name: "A" }],
  attempts: [],
  contentAvailable: true,
  contentVersion: 1,
  contentState: "available",
})

test("actual row badge expression works and all facets count route-filtered requests including warn-only matches", () => {
  const view = fixture()
  const warned = {
    ...entry(2),
    total: 0,
    byKind: {},
    warned: 1,
    detected: 1,
    detectedByKind: { HOME: 1 },
  }
  view.redactionStats = [entry(1), warned, entry(3, "Other")]
  view.clientFilter = "Codex"
  expect(view.routeFilteredRecords).toHaveLength(2)
  expect(view.kindTotal("HOME")).toBe(2)
  view.kindFilter = "HOME"
  expect(view.filteredRecords).toHaveLength(2)
  const template = readFileSync("pages/partials/redaction.html", "utf8")
  const expression = template.match(/x-for="tag in ([^"]+)"/)![1]
  const badges = runInNewContext("with(view) { " + expression + " }", {
    view,
    entry: warned,
  })
  expect(badges).toHaveLength(1)
  expect(badges[0].kind).toBe("HOME")
  expect(
    view.formatUpstreams({
      upstreams: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    }),
  ).toBe("A、B")
})

test("unavailable evidence still opens metadata and explains the reason without fetching payloads", async () => {
  let calls = 0
  const view = fixture(async () => {
    calls++
    return {}
  })
  view.redactionStats = [
    { ...entry(1), contentAvailable: false, contentState: "evicted" },
  ]
  view.inspection = { enabled: false, expiresAt: null }
  await view.loadDetail(1)
  expect(view.detailId).toBe(1)
  expect(view.detail.attempts).toHaveLength(0)
  expect(view.detailContentState).toBe("evicted")
  expect(calls).toBe(0)
})

test("open detail follows content revisions while preserving comparison mode and never fetching raw client input", async () => {
  let version = 1
  let plays = 0
  const view = fixture(async (url) =>
    url.includes("redaction-stats") ?
      {
        inspection: { enabled: true, expiresAt: null },
        entries: [{ ...entry(1), contentVersion: version }],
      }
    : {
        id: 1,
        version,
        input: "unnecessary original request",
        attempts: [],
        mappings: [],
        truncated: false,
      },
  )
  view.inspection = { enabled: true, expiresAt: null }
  view.redactionStats = [entry(1)]
  view.playRecordFlow = () => {
    plays++
  }
  await view.loadDetail(1, true)
  view.detailViewMode = "original"
  view.activePlaceholder = "selected"
  version = 2
  await view.loadRedactionStats(true)
  await Promise.resolve()
  expect(view.detail.version).toBe(2)
  expect(view.detailViewMode).toBe("original")
  expect(view.detailRevealed).toBe(true)
  expect(view.activePlaceholder).toBe("selected")
  expect(view.detail.input).toBeNull()
  expect(plays).toBe(0)
})

test("page exposes stale snapshots, true capture policy and request facts rather than a clickable pipeline", () => {
  const template = readFileSync("pages/partials/redaction.html", "utf8")
  expect(template).toContain("redactionStatsError")
  expect(template).toContain("redactionStatsLoading")
  expect(template).toContain("statsUpdatedAt")
  expect(template).toContain("inspectionSummary")
  expect(template).toContain("detailAttemptSummary")
  expect(template).not.toContain("selectPipelineStep(")
  expect(template).not.toContain("entry.total > 0 ? 'bg-[var(--apple-green)]'")
})

test("successful detail retry clears the refresh error", async () => {
  let fail = false
  const view = fixture(async () => {
    if (fail) throw new Error("offline")
    return { id: 1, version: 2, attempts: [], mappings: [] }
  })
  view.inspection = { enabled: true, expiresAt: null }
  view.redactionStats = [entry(1)]
  await view.loadDetail(1, true)
  fail = true
  await view.loadDetail(1, true, true)
  expect(view.detailError).toBe("redaction.inspect.error")
  fail = false
  await view.loadDetail(1, true, true)
  expect(view.detailError).toBe("")
  expect(view.detailRevealed).toBe(true)
})

test("a detail response arriving after content eviction cannot restore revealed values", async () => {
  let resolveDetail!: (value: unknown) => void
  const view = fixture(async (url) => {
    if (url.includes("redaction-stats"))
      return {
        inspection: { enabled: true, expiresAt: null },
        entries: [
          { ...entry(1), contentAvailable: false, contentState: "evicted" },
        ],
      }
    return new Promise((resolve) => {
      resolveDetail = resolve
    })
  })
  view.inspection = { enabled: true, expiresAt: null }
  view.redactionStats = [entry(1)]
  const pending = view.loadDetail(1, true)
  await view.loadRedactionStats(true)
  resolveDetail({
    id: 1,
    version: 1,
    attempts: [],
    mappings: [{ value: "sensitive" }],
  })
  await pending
  expect(view.detail).toBeNull()
  expect(view.detailRevealed).toBe(false)
  await view.loadDetail(1)
  expect(view.detailContentState).toBe("evicted")
  expect(view.detail.mappings).toHaveLength(0)
})

test("particles use sampled geometry after their source SVG path is detached", () => {
  let frame!: (now: number) => void
  let detached = false
  const node = {
    style: {},
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value)
    },
    remove: () => {},
  }
  const attributes = new Map<string, string>()
  const flow = runInNewContext(
    readFileSync("pages/js/views/redaction.js", "utf8")
      + "\n({ redactionFlow, spawnRedactionParticle })",
    {
      document: { hidden: false, createElementNS: () => node },
      performance: { now: () => 0 },
      requestAnimationFrame: (callback: (now: number) => void) => {
        frame = callback
        return 1
      },
    },
  )
  flow.redactionFlow.svg = { appendChild: () => {} }
  const path = {
    getTotalLength: () => 100,
    getPointAtLength: (position: number) => {
      if (detached) throw new Error("old path removed during layout update")
      return { x: position, y: position / 2 }
    },
  }
  flow.spawnRedactionParticle(path, 0, 1000, "token")
  detached = true
  frame(500)
  expect(attributes.get("transform")).toBe("translate(75 37.5)")
  expect(flow.redactionFlow.particles).toHaveLength(1)
  frame(1000)
  expect(flow.redactionFlow.particles).toHaveLength(0)
})

test("comparison controls fetch originals on explicit selection and switch all three modes", async () => {
  const calls: string[] = []
  const token = "{{HOME_abcdefgh}}"
  const view = fixture(async (url) => {
    calls.push(url)
    return {
      id: 1,
      version: 1,
      attempts: [{ upstream: { id: "a" }, body: token, stage: "http" }],
      mappings: [
        {
          placeholder: token,
          kind: "HOME",
          ...(url.includes("reveal=1") ? { value: "synthetic home" } : {}),
        },
      ],
    }
  })
  view.inspection = { enabled: true, expiresAt: null }
  view.redactionStats = [entry(1)]
  await view.loadDetail(1)
  const template = readFileSync("pages/partials/redaction.html", "utf8")
  for (const mode of ["both", "vendor", "original"]) {
    const button = [...template.matchAll(/<button\b[\s\S]*?<\/button>/g)]
      .map((match) => match[0])
      .find((html) => html.includes(`detailViewMode === '${mode}'`))!
    const disabled = button.match(/:disabled="([^"]+)"/)?.[1]
    if (disabled)
      expect(runInNewContext("with(view) { " + disabled + " }", { view })).toBe(
        false,
      )
    const click = button.match(/@click="([^"]+)"/)![1]
    await runInNewContext("with(view) { " + click + " }", { view })
    expect(view.detailViewMode).toBe(mode)
    if (mode !== "vendor") expect(view.detailRevealed).toBe(true)
  }
  expect(calls).toHaveLength(2)
  expect(calls[0]).not.toContain("reveal=1")
  expect(calls[1]).toContain("reveal=1")
  expect(view.excerptSegments(token, false, true)[0].text).toBe(
    "synthetic home",
  )
  expect(view.excerptSegments(token, false, false)[0].text).toBe(token)
})

test("failed comparison fetch leaves the masked mode active and shows its error", async () => {
  const view = fixture(async () => {
    throw new Error("offline")
  })
  view.inspection = { enabled: true, expiresAt: null }
  view.redactionStats = [entry(1)]
  view.detailId = 1
  view.detail = {
    mappings: [{ placeholder: "{{HOME_abcdefgh}}" }],
    attempts: [],
  }
  view.detailViewMode = "vendor"
  await view.selectDetailViewMode("original")
  expect(view.detailViewMode).toBe("vendor")
  expect(view.detailRevealed).toBe(false)
  expect(view.detailError).toBe("redaction.inspect.error")
})
