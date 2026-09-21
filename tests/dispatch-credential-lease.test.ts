/**
 * Per-credential in-flight gate (`tryAcquireCredentialLease`).
 *
 * Regression coverage for a gate that never actually bounded a streaming turn:
 * `execute()` returns a `decorateResult` wrapper (`{ credentialId, response,
 * identity }`), so testing `isAsyncIterable(result)` on the wrapper was always
 * false and the lease was released before the first chunk. See
 * `holdLeaseForStream` in ~/services/dispatch/failover.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ProviderAdmission } from "~/lib/request-admission"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  getProviderConnection,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import {
  __resetRouteTargetRoundRobin,
  buildRouteTargets,
  selectRouteTarget,
} from "~/lib/route-target"
import {
  __resetCredentialGatesForTest,
  tryAcquireCredentialLease,
  type CredentialLease,
} from "~/services/dispatch/concurrency"
import { executeWithFailover } from "~/services/dispatch/failover"

import { setTestConnections } from "./helpers/set-connections"

const isolationRoot = PATHS.APP_DIR
let tempAppDir: string

beforeEach(async () => {
  tempAppDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `failover-lease-test-${randomUUID()}-`),
  )
  redirectPathsToDir(tempAppDir)
  resetAdaptiveRateLimiterForTest()
  __resetCredentialGatesForTest()
})

afterEach(async () => {
  redirectPathsToDir(isolationRoot)
  __resetProviderConnectionsForTest()
  __resetRouteTargetRoundRobin()
  resetAdaptiveRateLimiterForTest()
  __resetCredentialGatesForTest()
  setTestConnections([])
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
})

async function setupConnection(id: string) {
  return createConnection({
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: `https://${id}.example.com/v1`,
    priority: 0,
    credentials: [{ id: `${id}-cred`, value: "sk-test", authMode: "bearer" }],
    models: [
      {
        publicId: "model-x",
        upstreamId: "model-x",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
  })
}

function buildAdmissionFor(modelId: string): ProviderAdmission {
  const targets = buildRouteTargets({
    publicModelId: modelId,
    endpoint: "chat",
  })
  const selected = selectRouteTarget(targets)
  expect(selected).not.toBeNull()
  const conn = getProviderConnection(
    (selected as NonNullable<typeof selected>).connectionId,
  )
  expect(conn).not.toBeNull()
  const connection = conn as NonNullable<typeof conn>
  return {
    target: selected as NonNullable<typeof selected>,
    connection,
    credential: connection.credentials[0],
    initiator: "user",
  }
}

/**
 * How many more leases the gate will grant right now, releasing them again.
 * Used to observe whether a turn is still counted as in flight without
 * hard-coding the cap (which is env-configurable).
 */
function remainingLeases(target: ProviderAdmission["target"]): number {
  const held: Array<CredentialLease> = []
  for (;;) {
    const lease = tryAcquireCredentialLease(target)
    if (!lease) break
    held.push(lease)
  }
  for (const lease of held) lease.release()
  return held.length
}

/** A controllable stream: `push()` feeds it, `finish()` ends it. */
function controllableStream<T>() {
  const queue: Array<T> = []
  let done = false
  let wake: (() => void) | undefined

  const settle = () => {
    const pending = wake
    wake = undefined
    pending?.()
  }

  const stream: AsyncIterable<T> = {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<T>> {
        while (queue.length === 0 && !done) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
        if (queue.length > 0) {
          return { value: queue.shift() as T, done: false }
        }
        return { value: undefined as never, done: true }
      },
    }),
  }

  return {
    stream,
    push: (value: T) => {
      queue.push(value)
      settle()
    },
    finish: () => {
      done = true
      settle()
    },
  }
}

async function* failingStream(): AsyncIterable<{ data: string }> {
  yield { data: "chunk-1" }
  throw new Error("upstream died mid-stream")
}

function wrapped(stream: unknown, provider = "openai-compatible") {
  return {
    credentialId: "conn-cred",
    response: stream,
    identity: {
      ownerId: "conn",
      connectionId: "conn",
      credentialId: "conn-cred",
      provider,
    },
  }
}

describe("per-credential lease across a streaming turn", () => {
  test("holds the lease while a wrapped stream is still open", async () => {
    await setupConnection("conn")
    const admission = buildAdmissionFor("model-x")
    const cap = remainingLeases(admission.target)
    expect(cap).toBeGreaterThan(1)

    const source = controllableStream<{ data: string }>()
    const result = await executeWithFailover({
      payload: { model: "model-x" },
      admission,
      routeKind: "chat",
      // Exactly what dispatchRequest's execute() returns: a decorateResult
      // wrapper with the stream on `.response`.
      execute: () => Promise.resolve(wrapped(source.stream)),
    })

    // The wrapper shape must be preserved for callers.
    expect(result.identity.provider).toBe("openai-compatible")
    expect(
      typeof (result.response as { [Symbol.asyncIterator]?: unknown })[
        Symbol.asyncIterator
      ],
    ).toBe("function")

    // The gate must still count this turn as in flight.
    expect(remainingLeases(admission.target)).toBe(cap - 1)

    // Consume the stream to completion; the lease releases at the end.
    source.push({ data: "chunk-1" })
    source.finish()
    const seen: Array<{ data: string }> = []
    for await (const event of result.response as AsyncIterable<{
      data: string
    }>) {
      seen.push(event)
    }
    expect(seen).toEqual([{ data: "chunk-1" }])
    expect(remainingLeases(admission.target)).toBe(cap)
  })

  test("releases the lease when a stream errors mid-flight", async () => {
    await setupConnection("conn")
    const admission = buildAdmissionFor("model-x")
    const cap = remainingLeases(admission.target)

    const result = await executeWithFailover({
      payload: { model: "model-x" },
      admission,
      routeKind: "chat",
      execute: () => Promise.resolve(wrapped(failingStream())),
    })
    expect(remainingLeases(admission.target)).toBe(cap - 1)

    await expect(
      (async () => {
        for await (const _event of result.response as AsyncIterable<unknown>) {
          // consume until the stream throws
        }
      })(),
    ).rejects.toThrow("upstream died mid-stream")

    // A mid-stream failure must not leak the gate.
    expect(remainingLeases(admission.target)).toBe(cap)
  })

  test("releases the lease immediately for a non-streaming result", async () => {
    await setupConnection("conn")
    const admission = buildAdmissionFor("model-x")
    const cap = remainingLeases(admission.target)

    const result = await executeWithFailover({
      payload: { model: "model-x" },
      admission,
      routeKind: "chat",
      execute: () =>
        Promise.resolve(wrapped({ id: "chatcmpl-1", choices: [] })),
    })

    expect(result.response).toEqual({ id: "chatcmpl-1", choices: [] })
    // Nothing held: a completed response frees its slot immediately.
    expect(remainingLeases(admission.target)).toBe(cap)
  })

  test("still holds the lease for a bare async iterable result", async () => {
    await setupConnection("conn")
    const admission = buildAdmissionFor("model-x")
    const cap = remainingLeases(admission.target)

    const source = controllableStream<string>()
    const result = await executeWithFailover({
      payload: { model: "model-x" },
      admission,
      routeKind: "chat",
      // An execute() that returns the stream directly (no wrapper).
      execute: () => Promise.resolve(source.stream),
    })

    expect(remainingLeases(admission.target)).toBe(cap - 1)

    source.push("value")
    source.finish()
    const seen: Array<string> = []
    for await (const item of result as unknown as AsyncIterable<string>) {
      seen.push(item)
    }
    expect(seen).toEqual(["value"])
    expect(remainingLeases(admission.target)).toBe(cap)
  })

  test("caps concurrent streaming turns on one credential", async () => {
    await setupConnection("conn")
    const admission = buildAdmissionFor("model-x")
    const cap = remainingLeases(admission.target)

    // Open `cap` never-ending streams: each must hold its slot.
    const results: Array<{ response: unknown }> = []
    for (let i = 0; i < cap; i += 1) {
      const source = controllableStream<unknown>()
      const result = await executeWithFailover({
        payload: { model: "model-x" },
        admission,
        routeKind: "chat",
        execute: () => Promise.resolve(wrapped(source.stream)),
      })
      results.push(result)
      // End the source, but do not drain the returned wrapper: the lease is
      // held by the wrapper, so the slot stays occupied until it is consumed.
      source.finish()
    }
    expect(remainingLeases(admission.target)).toBe(0)

    // The next concurrent turn is refused, which is what makes failover
    // rotate to another credential instead of flooding this one.
    expect(tryAcquireCredentialLease(admission.target)).toBeNull()

    // Draining one returned stream frees exactly one slot.
    for await (const _item of results[0].response as AsyncIterable<unknown>) {
      // drain to trigger the lease release
    }
    expect(remainingLeases(admission.target)).toBe(1)
  })
})
