import { afterEach, beforeEach, expect, test } from "bun:test"
import type { RouteTarget } from "~/lib/provider-connections"
import {
  getSystemConfig,
  initializeSystemConfig,
  updateSystemConfig,
} from "~/lib/system-config"
import { buildRouteTargets } from "~/lib/route-target"
import { routeTargetLoad } from "~/lib/route-target/load"
import {
  __resetCredentialGatesForTest,
  tryAcquireCredentialLease,
  waitForCredentialLease,
  type CredentialLease,
} from "~/services/dispatch/concurrency"
import { setTestAccounts } from "./helpers/set-accounts"

const normal = {
  logLevel: "info",
  requestDump: false,
  memoryVerbose: false,
  performanceDetails: true,
  debugMinutes: 15,
} as const
let targets: RouteTarget[]
beforeEach(() => {
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
  __resetCredentialGatesForTest()
  setTestAccounts(
    ["a", "b", "c"].map((id) => ({
      id,
      label: id,
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
      provider: "copilot" as const,
      credentials: { githubToken: "gh-test" },
      runtimeState: { copilotToken: "token" },
      availableModels: [
        {
          id: "gpt-4.1",
          name: "gpt-4.1",
          vendor: "OpenAI",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions"],
        },
      ],
    })),
  )
  targets = buildRouteTargets({ publicModelId: "gpt-4.1", endpoint: "chat" })
  expect(targets).toHaveLength(3)
})
afterEach(() => {
  __resetCredentialGatesForTest()
  setTestAccounts([])
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
})
function occupy(target: RouteTarget): CredentialLease[] {
  const leases: CredentialLease[] = []
  for (;;) {
    const lease = tryAcquireCredentialLease(target)
    if (!lease) return leases
    leases.push(lease)
  }
}
function key(target: RouteTarget): string {
  return `${target.connectionId}::${target.credentialId}::${target.endpoint}`
}

test("FIFO queue reserves released slots before new arrivals, across candidate lanes", async () => {
  const heldA = occupy(targets[0])
  const heldB = occupy(targets[1])
  const order: string[] = []
  const first = waitForCredentialLease([targets[0], targets[1]]).then(
    (grant) => {
      order.push("first")
      return grant
    },
  )
  const second = waitForCredentialLease([targets[1]]).then((grant) => {
    order.push("second")
    return grant
  })
  heldB.pop()!.release()
  expect(tryAcquireCredentialLease(targets[1])).toBeNull()
  const grant = await first
  expect(grant.target.connectionId).toBe(targets[1].connectionId)
  expect(order).toEqual(["first"])
  grant.lease.release()
  const next = await second
  expect(order).toEqual(["first", "second"])
  next.lease.release()
  for (const lease of [...heldA, ...heldB]) lease.release()
})

test("queue is globally bounded, can be disabled live, and cancellation frees queue space", async () => {
  updateSystemConfig({ ...normal, concurrencyQueueLimit: 1 })
  const held = occupy(targets[0])
  const abort = new AbortController()
  const waiting = waitForCredentialLease([targets[0]], abort.signal).catch(
    (error: unknown) => error,
  )
  await expect(waitForCredentialLease([targets[1]])).rejects.toMatchObject({
    response: { status: 429 },
  })
  const reason = new Error("client left")
  abort.abort(reason)
  expect(await waiting).toBe(reason)
  const grant = await waitForCredentialLease([targets[1]])
  grant.lease.release()
  updateSystemConfig({ ...normal, concurrencyQueueLimit: 0 })
  await expect(waitForCredentialLease([targets[0]])).rejects.toMatchObject({
    response: { status: 429 },
  })
  for (const lease of held) lease.release()
})

test("timeout returns a local retryable 429 without consuming a slot", async () => {
  updateSystemConfig({ ...normal, concurrencyQueueWaitSeconds: 1 })
  const held = occupy(targets[0])
  await expect(waitForCredentialLease([targets[0]])).rejects.toMatchObject({
    response: { status: 429 },
    message: "Concurrency queue wait timed out; retry shortly",
  })
  expect(routeTargetLoad(key(targets[0]))).toBe(held.length)
  for (const lease of held) lease.release()
})

test("a disjoint idle lane proceeds while another lane is queued", async () => {
  const held = occupy(targets[0])
  const abort = new AbortController()
  const waiting = waitForCredentialLease([targets[0]], abort.signal).catch(
    () => {},
  )
  const granted = await waitForCredentialLease([targets[2]])
  granted.lease.release()
  abort.abort()
  await waiting
  for (const lease of held) lease.release()
})

test("grant followed by cancellation releases exactly one slot when caller observes abort", async () => {
  const held = occupy(targets[0])
  const abort = new AbortController()
  const waiting = waitForCredentialLease([targets[0]], abort.signal)
  held.pop()!.release()
  abort.abort()
  await expect(waiting).rejects.toBe(abort.signal.reason)
  expect(routeTargetLoad(key(targets[0]))).toBe(held.length)
  for (const lease of held) lease.release()
})

test("queue settings are persistent and optional updates preserve existing limits", () => {
  let saved = ""
  initializeSystemConfig({
    save: (value) => {
      saved = value
    },
    onChange: () => {},
  })
  updateSystemConfig({
    ...normal,
    concurrencyQueueLimit: 45,
    concurrencyQueueWaitSeconds: 9,
  })
  initializeSystemConfig({ value: saved, save: () => {}, onChange: () => {} })
  updateSystemConfig(normal)
  expect(getSystemConfig().settings).toMatchObject({
    concurrencyQueueLimit: 45,
    concurrencyQueueWaitSeconds: 9,
  })
  for (const value of [-1, 10001, 1.5, "1"])
    expect(() =>
      updateSystemConfig({ ...normal, concurrencyQueueLimit: value }),
    ).toThrow()
  for (const value of [0, 601, 1.5, "1"])
    expect(() =>
      updateSystemConfig({ ...normal, concurrencyQueueWaitSeconds: value }),
    ).toThrow()
})

test("a hundred queued requests complete in FIFO order without exceeding the lane cap", async () => {
  const held = occupy(targets[0])
  const cap = held.length
  const order: number[] = []
  let peak = 0
  const waiting = Array.from({ length: 100 }, (_, index) =>
    waitForCredentialLease([targets[0]]).then(({ lease }) => {
      order.push(index)
      peak = Math.max(peak, routeTargetLoad(key(targets[0])))
      lease.release()
    }),
  )
  held.pop()!.release()
  await Promise.all(waiting)
  expect(order).toEqual(Array.from({ length: 100 }, (_, index) => index))
  expect(peak).toBe(cap)
  expect(routeTargetLoad(key(targets[0]))).toBe(cap - 1)
  for (const lease of held) lease.release()
})

test("a credential disabled during its wait is never granted", async () => {
  const held = occupy(targets[0])
  const pending = waitForCredentialLease([targets[0]])
  const { getProviderConnection } = await import("~/lib/provider-connections")
  getProviderConnection(targets[0].connectionId)!.credentials[0].enabled = false
  held.pop()!.release()
  await expect(pending).rejects.toMatchObject({
    response: { status: 429 },
    message: "Queued connections are no longer available; retry shortly",
  })
  expect(routeTargetLoad(key(targets[0]))).toBe(held.length)
  for (const lease of held) lease.release()
})

test("old persisted settings gain bounded queue defaults", () => {
  const settings = { ...getSystemConfig().settings }
  const {
    concurrencyQueueLimit: _limit,
    concurrencyQueueWaitSeconds: _wait,
    ...old
  } = settings
  initializeSystemConfig({
    value: JSON.stringify({ settings: old, expiresAt: null }),
    save: () => {},
    onChange: () => {},
  })
  expect(getSystemConfig().settings).toMatchObject({
    concurrencyQueueLimit: 100,
    concurrencyQueueWaitSeconds: 30,
  })
})
