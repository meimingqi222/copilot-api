import { afterEach, describe, expect, test } from "bun:test"

import type { UpstreamWsSession } from "~/services/responses/upstream-ws-consumer"

import {
  clearUpstreamWebsocketSessionsForTest,
  pruneIdleUpstreamSessionsForTest,
} from "~/services/responses/upstream-ws"
import {
  createTurnConsumer,
  sessions,
} from "~/services/responses/upstream-ws-consumer"

function makeFakeWs() {
  const listeners = new Map<string, Set<(event: never) => void>>()
  const fake = {
    closeCalls: 0,
    addEventListener(type: string, listener: (event: never) => void) {
      const set = listeners.get(type) ?? new Set<(event: never) => void>()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: (event: never) => void) {
      listeners.get(type)?.delete(listener)
    },
    close() {
      fake.closeCalls += 1
    },
    emit(type: string, event: never) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
  }
  return fake
}

function makeSession(key: string, ws: unknown): UpstreamWsSession {
  return {
    key,
    provider: "codex",
    executionSessionId: "exec-1",
    url: "wss://example.invalid/responses",
    accountId: "acc-1",
    ws: ws as UpstreamWsSession["ws"],
    chain: Promise.resolve(),
    closed: false,
    lastUsedAt: 0,
    openedAt: Date.now(),
    activeTurns: 0,
    localCloseReason: null,
  }
}

afterEach(() => {
  clearUpstreamWebsocketSessionsForTest()
})

describe("upstream websocket idle reaper", () => {
  test("never reaps a socket with a turn in flight", () => {
    const ws = makeFakeWs()
    const sess = makeSession("codex::acc-1::exec-1", ws)
    sess.activeTurns = 1
    sess.lastUsedAt = Date.now()
    sessions.set(sess.key, sess)

    pruneIdleUpstreamSessionsForTest(Date.now())

    expect(sessions.get(sess.key)).toBe(sess)
    expect(ws.closeCalls).toBe(0)
  })

  test("keeps a busy socket past the idle timeout but within max age", () => {
    // The reported incident: a ~6min generation with events flowing must
    // survive the 5min idle reaper while its turn holds the socket.
    const ws = makeFakeWs()
    const sess = makeSession("codex::acc-1::exec-1", ws)
    sess.activeTurns = 1
    const now = Date.now()
    sess.lastUsedAt = now - 6 * 60_000
    sessions.set(sess.key, sess)

    pruneIdleUpstreamSessionsForTest(now)

    expect(sessions.get(sess.key)).toBe(sess)
    expect(ws.closeCalls).toBe(0)
  })

  test("reaps a wedged busy socket past the max socket age", () => {
    // An abandoned consumer that never releases must not pin a socket
    // past the provider hard limit (55min for codex).
    const ws = makeFakeWs()
    const sess = makeSession("codex::acc-1::exec-1", ws)
    sess.activeTurns = 1
    const now = Date.now()
    sess.lastUsedAt = now - 56 * 60_000
    sessions.set(sess.key, sess)

    pruneIdleUpstreamSessionsForTest(now)

    expect(sessions.has(sess.key)).toBe(false)
    expect(ws.closeCalls).toBe(1)
    expect(sess.localCloseReason).toBe("idle_timeout")
  })

  test("reaps a truly idle socket", () => {
    const ws = makeFakeWs()
    const sess = makeSession("codex::acc-1::exec-1", ws)
    sessions.set(sess.key, sess)

    pruneIdleUpstreamSessionsForTest(Date.now())

    expect(sessions.has(sess.key)).toBe(false)
    expect(ws.closeCalls).toBe(1)
    expect(sess.localCloseReason).toBe("idle_timeout")
  })

  test("consumer heartbeats lastUsedAt and tracks active turns", () => {
    const ws = makeFakeWs()
    const sess = makeSession("codex::acc-1::exec-1", ws)
    sess.lastUsedAt = 1
    let released = false
    const consumer = createTurnConsumer({
      provider: "codex",
      accountId: "acc-1",
      executionSessionId: "exec-1",
      key: sess.key,
      sess,
      ws: ws as unknown as WebSocket,
      releaseChain: () => {
        released = true
      },
    })
    expect(sess.activeTurns).toBe(1)

    ws.emit("message", { data: '{"type":"response.created"}' } as never)
    expect(sess.lastUsedAt).toBeGreaterThan(1)

    consumer.dispose()
    expect(sess.activeTurns).toBe(0)
    expect(released).toBe(true)
  })
})
