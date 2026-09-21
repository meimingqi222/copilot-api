/**
 * Responses WebSocket per-credential in-flight gate.
 *
 * The WS path does not go through `executeWithFailover`, so before this gate it
 * bypassed every dispatch-layer concurrency control. Session affinity pins many
 * Codex sessions onto one credential on purpose, which makes cross-session
 * pile-up on a single credential the expected shape — and there was no bound on
 * it. A `CredentialConcurrencyLimitError` must also not be misclassified as a
 * connection problem: that would trigger the same-account HTTP recovery, which
 * holds no lease and would tunnel around the gate.
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { RouteTarget } from "~/lib/provider-connections"

import { bunWebsocket } from "~/lib/bun-websocket"
import { listAccounts } from "~/lib/legacy-accounts"
import { logStore } from "~/lib/log-store"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { getProviderConnection } from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import {
  __resetRouteTargetRoundRobin,
  buildRouteTargets,
  selectRouteTarget,
} from "~/lib/route-target"
import { clearSessionAffinityForTest } from "~/lib/routing"
import { state } from "~/lib/state"
import { server } from "~/server"
import {
  __resetCredentialGatesForTest,
  tryAcquireCredentialLease,
  type CredentialLease,
} from "~/services/dispatch/concurrency"

import { setTestAccounts } from "./helpers/set-accounts"

const ACCOUNT_ID = "test-account-id"
const MODEL = "gpt-responses"

const originalFetch = globalThis.fetch
const originalAccounts = listAccounts()
const originalModels = state.models
const originalApiKey = state.legacyApiKey
const originalVsCodeVersion = state.vsCodeVersion
const originalAccountType = state.accountType
const originalUsers = state.users
const originalRouting = { ...state.routing }

beforeEach(() => {
  resetProtectedRouteGuardForTest()
  resetAdaptiveRateLimiterForTest()
  clearSessionAffinityForTest()
  __resetRouteTargetRoundRobin()
  __resetCredentialGatesForTest()
  logStore.clearForTest()
  setTestAccounts([
    {
      id: ACCOUNT_ID,
      label: "test",
      provider: "copilot",
      credentials: { githubToken: "gh-test-token" },
      runtimeState: { copilotToken: "test-token" },
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
    },
  ])
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
  state.legacyApiKey = undefined
  state.users = []
  state.routing = { ...originalRouting }
  state.models = {
    object: "list",
    data: [
      {
        id: MODEL,
        object: "model",
        name: "GPT Responses",
        preview: false,
        vendor: "OpenAI",
        version: "1",
        model_picker_enabled: true,
        supported_endpoints: ["/responses"],
        capabilities: {
          family: "gpt-5",
          object: "capabilities",
          supports: {},
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ],
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setTestAccounts(originalAccounts)
  state.models = originalModels
  state.legacyApiKey = originalApiKey
  state.vsCodeVersion = originalVsCodeVersion
  state.accountType = originalAccountType
  state.users = originalUsers
  state.routing = { ...originalRouting }
  __resetCredentialGatesForTest()
  clearSessionAffinityForTest()
  __resetRouteTargetRoundRobin()
})

/** The exact target the WS handler will resolve for this account + model. */
function responsesTarget(): RouteTarget {
  const candidates = buildRouteTargets({
    publicModelId: MODEL,
    endpoint: "responses",
  })
  const selected = selectRouteTarget(candidates)
  if (!selected) throw new Error("no route target for the test account")
  return selected
}

/**
 * How many more leases the gate grants right now, releasing them again. Used to
 * observe occupancy without hard-coding the env-configurable cap.
 */
function remainingLeases(target: RouteTarget): number {
  const held: Array<CredentialLease> = []
  for (;;) {
    const lease = tryAcquireCredentialLease(target)
    if (!lease) break
    held.push(lease)
  }
  for (const lease of held) lease.release()
  return held.length
}

/** Hold `count` leases on the credential, returning their release handles. */
function occupy(target: RouteTarget, count: number): Array<CredentialLease> {
  const held: Array<CredentialLease> = []
  for (let i = 0; i < count; i += 1) {
    const lease = tryAcquireCredentialLease(target)
    if (!lease) throw new Error("could not occupy the requested slots")
    held.push(lease)
  }
  return held
}

test("a WS turn at the in-flight cap is rejected without a same-account HTTP retry", async () => {
  const target = responsesTarget()
  const cap = remainingLeases(target)
  expect(cap).toBeGreaterThan(1)

  const fetchMock = mock(() => Promise.resolve(new Response("nope")))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  // Saturate the credential from "other sessions".
  const held = occupy(target, cap)

  using appServer = Bun.serve({
    port: 0,
    fetch: server.fetch,
    websocket: bunWebsocket,
  })
  const { ws, queue } = await openSocket(
    `ws://localhost:${appServer.port}/v1/responses`,
  )

  ws.send(
    JSON.stringify({
      type: "response.create",
      response: { model: MODEL, input: "hi" },
    }),
  )

  const message = JSON.parse(await queue.next()) as {
    type: string
    status: number
    error: { type: string; code?: number; retryable?: boolean }
  }

  expect(message.type).toBe("error")
  // Local saturation is a retryable 429, not a 500.
  expect(message.status).toBe(429)
  expect(message.error.type).toBe("rate_limit_error")
  expect(message.error.retryable).toBe(true)

  // The rejection must NOT be treated as a lazy connection failure: the
  // same-account HTTP recovery bypasses the lease, so reaching it would let a
  // throttled turn tunnel around its own limiter.
  expect(fetchMock).not.toHaveBeenCalled()

  // The saturated credential is healthy, just busy: it must not be cooled.
  const connection = getProviderConnection(ACCOUNT_ID)
  expect(connection?.credentials[0]?.cooldownUntil).toBeUndefined()
  expect(connection?.credentials[0]?.status).toBe("ready")

  for (const lease of held) lease.release()
  ws.close()
})

test("a saturated WS turn rotates to the next account instead of being refused", async () => {
  // Two accounts, the first pinned by session affinity and locally saturated.
  // The session must fail over to the second, not surface a 429 while a
  // healthy second account sits idle.
  setTestAccounts([
    {
      id: ACCOUNT_ID,
      label: "test",
      provider: "copilot",
      credentials: { githubToken: "gh-test-token" },
      runtimeState: { copilotToken: "test-token" },
      enabled: true,
      priority: 0,
      isExhausted: false,
      createdAt: Date.now(),
    },
    {
      id: "second-account-id",
      label: "second",
      provider: "copilot",
      credentials: { githubToken: "gh-test-token-2" },
      runtimeState: { copilotToken: "test-token-2" },
      enabled: true,
      priority: 1,
      isExhausted: false,
      createdAt: Date.now(),
    },
  ])

  const first = responsesTarget()
  expect(first.connectionId).toBe(ACCOUNT_ID)
  const cap = remainingLeases(first)
  expect(cap).toBeGreaterThan(1)

  // The upstream returns a normal non-streaming response; the point is which
  // credential served it. One POST means the turn executed once, on the
  // rotated-to account rather than being refused.
  let upstreamCalls = 0
  globalThis.fetch = mock(() => {
    upstreamCalls += 1
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: crypto.randomUUID(),
          object: "response",
          model: MODEL,
          status: "completed",
          output: [],
          output_text: "rotated",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      ),
    )
  }) as unknown as typeof fetch

  // Saturate the affinity-bound first account from "other sessions".
  const held = occupy(first, cap)

  using appServer = Bun.serve({
    port: 0,
    fetch: server.fetch,
    websocket: bunWebsocket,
  })
  const { ws, queue } = await openSocket(
    `ws://localhost:${appServer.port}/v1/responses`,
  )

  ws.send(
    JSON.stringify({
      type: "response.create",
      response: { model: MODEL, input: "rotate-me" },
    }),
  )

  const message = JSON.parse(await queue.next()) as {
    type?: string
    object?: string
    output_text?: string
  }

  // Served (rotated to the second account), not refused with a 429.
  expect(message.type).toBeUndefined()
  expect(message.object).toBe("response")
  expect(message.output_text).toBe("rotated")
  expect(upstreamCalls).toBe(1)

  // And it was the *second* account that served it — proving the rotation
  // moved the turn rather than re-hitting the saturated account.
  await waitFor(() =>
    logStore
      .query({ endpoint: "responses", limit: 10 })
      .entries.some((entry) => entry.method === "WS"),
  )
  const turn = logStore
    .query({ endpoint: "responses", limit: 10 })
    .entries.find((entry) => entry.method === "WS")
  expect(turn?.accountId).toBe("second-account-id")

  // The rotation must not have cooled the saturated-but-healthy first account.
  const firstConnection = getProviderConnection(ACCOUNT_ID)
  expect(firstConnection?.credentials[0]?.cooldownUntil).toBeUndefined()
  expect(firstConnection?.credentials[0]?.status).toBe("ready")

  for (const lease of held) lease.release()
  ws.close()
})

test("a WS turn holds a slot while in flight and releases it on client close", async () => {
  const target = responsesTarget()
  const cap = remainingLeases(target)
  expect(cap).toBeGreaterThan(1)

  // Leave exactly one slot for the WS turn.
  const held = occupy(target, cap - 1)
  const freeSlots = remainingLeases(target)
  expect(freeSlots).toBe(1)

  globalThis.fetch = mock(
    (_url: string, opts?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        opts?.signal?.addEventListener(
          "abort",
          () => {
            const err = new Error("The operation was aborted")
            err.name = "AbortError"
            reject(err)
          },
          { once: true },
        )
      }),
  ) as unknown as typeof fetch

  using appServer = Bun.serve({
    port: 0,
    fetch: server.fetch,
    websocket: bunWebsocket,
  })
  const { ws } = await openSocket(
    `ws://localhost:${appServer.port}/v1/responses`,
  )

  ws.send(
    JSON.stringify({
      type: "response.create",
      response: { model: MODEL, input: "slow" },
    }),
  )

  // The in-flight turn takes the last slot: nothing is available any more.
  await waitFor(() => remainingLeases(target) === 0)

  ws.close()

  // The disconnected turn must not leak its slot: exactly the one it held must
  // come back, while the `cap - 1` test-held slots stay occupied.
  await waitFor(() => remainingLeases(target) === freeSlots)

  for (const lease of held) lease.release()
})

test("an idle WS session holds no credential slot", async () => {
  const target = responsesTarget()
  const cap = remainingLeases(target)

  using appServer = Bun.serve({
    port: 0,
    fetch: server.fetch,
    websocket: bunWebsocket,
  })
  const { ws } = await openSocket(
    `ws://localhost:${appServer.port}/v1/responses`,
  )

  // Socket open, no turn in flight: an idle Codex session must not consume
  // quota, or a handful of parked sessions would starve the account.
  await Bun.sleep(30)
  expect(remainingLeases(target)).toBe(cap)

  ws.close()
})

test("the WS gate counts only in-flight turns, not open upstream sockets", async () => {
  const target = responsesTarget()
  const cap = remainingLeases(target)

  // Two completed turns in a row must return to a full pool: the lease is
  // acquired per turn, not per session.
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          id: crypto.randomUUID(),
          object: "response",
          model: MODEL,
          status: "completed",
          output: [],
          output_text: "",
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch

  using appServer = Bun.serve({
    port: 0,
    fetch: server.fetch,
    websocket: bunWebsocket,
  })
  const { ws, queue } = await openSocket(
    `ws://localhost:${appServer.port}/v1/responses`,
  )

  for (let i = 0; i < 2; i += 1) {
    ws.send(
      JSON.stringify({
        type: "response.create",
        response: { model: MODEL, input: `turn-${i}` },
      }),
    )
    await queue.next()
  }

  await waitFor(() => remainingLeases(target) === cap)
  ws.close()
})

interface SocketQueue {
  next: (timeoutMs?: number) => Promise<string>
}

async function openSocket(
  url: string,
): Promise<{ ws: WebSocket; queue: SocketQueue }> {
  const ws = new WebSocket(url)
  const queue = createSocketQueue(ws)

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for websocket open"))
    }, 2_000)

    ws.addEventListener("open", () => {
      clearTimeout(timeout)
      resolve()
    })

    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      reject(new Error("WebSocket failed to connect"))
    })
  })

  return { ws, queue }
}

function createSocketQueue(ws: WebSocket): SocketQueue {
  const buffered: Array<string> = []
  const waiters: Array<(value: string) => void> = []

  ws.addEventListener(
    "message",
    (event: MessageEvent<string | Blob | ArrayBuffer>) => {
      void toText(event.data).then((text) => {
        const waiter = waiters.shift()
        if (waiter) {
          waiter(text)
          return
        }
        buffered.push(text)
      })
    },
  )

  return {
    next(timeoutMs = 2_000) {
      if (buffered.length > 0) {
        return Promise.resolve(buffered.shift() ?? "")
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(resolve)
          if (index !== -1) waiters.splice(index, 1)
          reject(new Error("Timed out waiting for websocket message"))
        }, timeoutMs)
        waiters.push((value) => {
          clearTimeout(timeout)
          resolve(value)
        })
      })
    },
  }
}

async function toText(data: string | Blob | ArrayBuffer): Promise<string> {
  if (typeof data === "string") return data
  if (data instanceof Blob) return await data.text()
  return Buffer.from(data).toString("utf8")
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition")
    }
    await Bun.sleep(5)
  }
}
