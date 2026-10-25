import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface View {
  logTab: string
  filters: Record<string, string>
  entries: Array<{ ts: number; id: number; msg: string }>
  more: boolean
  status: {
    jobs: Array<{ name: string; lastOutcome?: string }>
    connections?: Array<{
      id: string
      name?: string
      lastError?: string
      credentials: Array<{ status: string; lastError?: string }>
    }>
  } | null
  selectedConnection: { id: string; lastError?: string } | null
  troubledConnections: Array<{ id: string }>
  jobs: Array<{ name: string }>
  bundle: {
    open: boolean
    sections: Record<string, boolean>
    preview: { manifest: { counts: Record<string, number> } } | null
  }
  init(): void
  load(older?: boolean): Promise<void>
  showRequest(id: string): void
  showRun(job: string, run: string): void
  showConnection(id: string): void
  loadStatus(): Promise<void>
  openBundle(): void
  previewBundle(): Promise<void>
  $watch(key: string, callback: (value: string) => void): void
}

function view(responses: Record<string, unknown>) {
  const calls: Array<string> = []
  // init() registers watchers; these tests drive the methods directly.
  const api = {
    systemLogs: {
      get: (filters: Record<string, unknown>) => {
        calls.push(`get ${JSON.stringify(filters)}`)
        return Promise.resolve(responses.get)
      },
    },
    diagnostics: {
      status: () => {
        calls.push("status")
        return Promise.resolve(responses.status)
      },
      preview: (options: unknown) => {
        calls.push(`preview ${JSON.stringify(options)}`)
        return Promise.resolve(responses.preview)
      },
    },
  }
  const instance = runInNewContext(
    readFileSync("pages/js/views/system-logs.js", "utf8")
      + "\nsystemLogsView()",
    {
      API: api,
      I18n: { t: (key: string) => key },
      ViewHelpers: { showToast: () => {} },
      EventSource: class {},
    },
  ) as View
  instance.logTab = "requests"
  instance.$watch = () => {}
  Object.assign(instance, {
    $nextTick: (callback: () => void) => callback(),
    $refs: { systemLogPanel: { scrollIntoView: () => {} } },
  })
  instance.init()
  return { instance, calls }
}

test("a request's system logs open filtered by its id, and paging asks for older entries", async () => {
  const { instance, calls } = view({
    get: { entries: [{ ts: 50, id: 2, msg: "b" }], more: true },
  })
  instance.showRequest("req-1")
  expect(instance.logTab).toBe("system")
  expect(instance.filters.req).toBe("req-1")
  await instance.load()
  expect(calls[0]).toContain('"req":"req-1"')
  await instance.load(true)
  expect(calls.at(-1)).toContain('"before":50')
  expect(instance.entries).toHaveLength(2)
})

test("on the system tab already, a job run's lines load at once", async () => {
  const { instance, calls } = view({ get: { entries: [], more: false } })
  instance.logTab = "system"
  instance.showRun("quota-refresh", "r1")
  await Promise.resolve()
  expect(calls[0]).toContain('"job":"quota-refresh"')
  expect(calls[0]).toContain('"run":"r1"')
})

test("status lists failed jobs first; the bundle dialog previews the chosen sections", async () => {
  const { instance, calls } = view({
    status: {
      jobs: [
        { name: "a", lastOutcome: "ok", lastStartAt: 5 },
        { name: "b", lastOutcome: "error", lastStartAt: 1 },
        { name: "c", lastOutcome: "warn", lastStartAt: 2 },
      ],
      connections: [],
    },
    preview: { manifest: { counts: { requests: 3 } }, bytes: 10 },
  })
  await instance.loadStatus()
  expect(instance.jobs.map((job) => job.name)).toEqual(["b", "c", "a"])
  instance.bundle.sections.requests = false
  instance.openBundle()
  expect(instance.bundle.open).toBe(true)
  await instance.previewBundle()
  const preview = calls.find((call) => call.startsWith("preview"))!
  expect(preview).not.toContain('"requests"]')
  expect(preview).toContain('"sinceHours":24')
  expect(instance.bundle.preview?.manifest.counts.requests).toBe(3)
})

test("related connection logs switch tabs, clear stale filters and keep the saved error visible", async () => {
  const { instance, calls } = view({ get: { entries: [], more: false } })
  instance.status = {
    jobs: [],
    connections: [
      {
        id: "conn-old",
        name: "Old account",
        lastError: "retained error",
        credentials: [],
      },
    ],
  }
  instance.filters = { req: "old-request", q: "old-query", level: "error" }
  instance.showConnection("conn-old")
  expect(instance.logTab).toBe("system")
  expect(instance.filters).toMatchObject({
    conn: "conn-old",
    connName: "Old account",
    req: "",
    q: "",
    level: "",
  })
  expect(instance.selectedConnection?.lastError).toBe("retained error")
  instance.showConnection("conn-old")
  await Promise.resolve()
  expect(calls.at(-1)).toContain('"conn":"conn-old"')
})

test("runtime status distinguishes ready connections from credential failures", () => {
  const { instance } = view({})
  instance.status = {
    jobs: [],
    connections: [
      { id: "healthy", credentials: [{ status: "ready" }] },
      { id: "auth-error", credentials: [{ status: "auth_error" }] },
      {
        id: "last-error",
        credentials: [{ status: "ready", lastError: "refresh failed" }],
      },
    ],
  }
  expect(instance.troubledConnections.map((item) => item.id)).toEqual([
    "auth-error",
    "last-error",
  ])
})
