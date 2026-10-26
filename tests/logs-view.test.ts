import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

interface Log {
  requestId: string
}
interface View {
  selectedLog: Log | null
  bodies: Log | null
  bodiesLoading: boolean
  bodiesError: string | null
  entries: Log[]
  selectLog(log: Log): void
  loadBodies(): Promise<void>
  load(): Promise<void>
}

function deferred() {
  let resolve!: (value: Log) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Log>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function createView() {
  const requests: Array<ReturnType<typeof deferred> & { id: string }> = []
  const view = runInNewContext(
    readFileSync("pages/js/views/logs.js", "utf8") + "\nlogsView()",
    {
      ViewHelpers: {},
      I18n: { t: (key: string) => key },
      API: {
        logs: {
          bodies: (id: string) => {
            const request = { ...deferred(), id }
            requests.push(request)
            return request.promise
          },
          get: async () => ({ entries: [], total: 0 }),
        },
      },
    },
  ) as View
  Object.assign(view, { $nextTick: () => {} })
  return { view, requests }
}

test("switching requests loads the new body and ignores the old result", async () => {
  const { view, requests } = createView()
  view.selectLog({ requestId: "A" })
  const first = view.loadBodies()
  view.selectLog({ requestId: "B" })
  expect(view.bodiesLoading).toBe(false)
  const second = view.loadBodies()
  expect(requests.map((request) => request.id)).toEqual(["A", "B"])
  requests[0].resolve({ requestId: "A" })
  await first
  expect(view.bodies).toBeNull()
  expect(view.bodiesLoading).toBe(true)
  requests[1].resolve({ requestId: "B" })
  await second
  expect(view.bodies).toEqual({ requestId: "B" })
  expect(view.bodiesLoading).toBe(false)
})

test("returning to the same request cannot revive an older body or error", async () => {
  for (const fail of [false, true]) {
    const { view, requests } = createView()
    view.selectLog({ requestId: "A" })
    const first = view.loadBodies()
    view.selectLog({ requestId: "B" })
    view.selectLog({ requestId: "A" })
    const latest = view.loadBodies()
    requests[1].resolve({ requestId: "latest A" })
    await latest
    if (fail) requests[0].reject(new Error("old failure"))
    else requests[0].resolve({ requestId: "old A" })
    await first
    expect(view.bodies).toEqual({ requestId: "latest A" })
    expect(view.bodiesError).toBeNull()
  }
})

test("closing or filtering out a request invalidates its pending body", async () => {
  for (const filterOut of [false, true]) {
    const { view, requests } = createView()
    view.selectLog({ requestId: "A" })
    const pending = view.loadBodies()
    if (filterOut) await view.load()
    else view.selectLog({ requestId: "A" })
    requests[0].resolve({ requestId: "A" })
    await pending
    expect(view.selectedLog).toBeNull()
    expect(view.bodies).toBeNull()
    expect(view.bodiesLoading).toBe(false)
  }
})

test("current body failures remain visible and can be retried", async () => {
  const { view, requests } = createView()
  view.selectLog({ requestId: "A" })
  const failed = view.loadBodies()
  requests[0].reject(new Error("load failed"))
  await failed
  expect(view.bodiesError).toBe("load failed")
  expect(view.bodiesLoading).toBe(false)
  const retry = view.loadBodies()
  expect(view.bodiesError).toBeNull()
  requests[1].resolve({ requestId: "A" })
  await retry
  expect(view.bodies).toEqual({ requestId: "A" })
})
