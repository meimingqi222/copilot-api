import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { parseMessage } from "~/services/windsurf/protobuf"
import { buildRequest } from "~/services/windsurf/request-builders"
import {
  clearWindsurfSessionTurnCountersForTest,
  nextWindsurfSessionTurnIndex,
  resetWindsurfSessionTurnIndex,
} from "~/services/windsurf/session-turn"

function decodeFramedPayload(framed: Uint8Array): Uint8Array {
  if (framed.length < 5) return framed
  const flags = framed[0]
  const payload = framed.subarray(5)
  if (flags === 1 || flags === 3) {
    return new Uint8Array(Bun.gunzipSync(Buffer.from(payload)))
  }
  return payload
}

function field15Entries(payload: Uint8Array): Map<number, number | string> {
  const node = parseMessage(payload, 0, 6).find((n) => n.field === 15 && n.sub)
  const entries = new Map<number, number | string>()
  for (const sub of node?.sub ?? []) {
    if (sub.wire === 0 && sub.varint !== undefined) {
      entries.set(sub.field, sub.varint)
    } else if (sub.raw) {
      entries.set(sub.field, new TextDecoder().decode(sub.raw))
    }
  }
  return entries
}

function userPayload(): ChatCompletionsPayload {
  return {
    model: "swe-test",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  }
}

function buildFor(
  cascadeId: string,
  turnIndex?: number,
): Map<number, number | string> {
  const framed = buildRequest({
    payload: userPayload(),
    apiKey: "test-key",
    requestModel: "MODEL_TEST",
    cascadeId,
    turnIndex,
  })
  return field15Entries(decodeFramedPayload(framed))
}

describe("windsurf session turn counter", () => {
  test("first request returns 0 and increments monotonically", () => {
    clearWindsurfSessionTurnCountersForTest()
    expect(nextWindsurfSessionTurnIndex("sess-1")).toBe(0)
    expect(nextWindsurfSessionTurnIndex("sess-1")).toBe(1)
    expect(nextWindsurfSessionTurnIndex("sess-1")).toBe(2)
  })

  test("counters are per-session", () => {
    clearWindsurfSessionTurnCountersForTest()
    expect(nextWindsurfSessionTurnIndex("a")).toBe(0)
    expect(nextWindsurfSessionTurnIndex("b")).toBe(0)
    expect(nextWindsurfSessionTurnIndex("a")).toBe(1)
  })

  test("empty session id always returns 0 without tracking", () => {
    clearWindsurfSessionTurnCountersForTest()
    expect(nextWindsurfSessionTurnIndex("")).toBe(0)
    expect(nextWindsurfSessionTurnIndex("   ")).toBe(0)
  })

  test("reset drops the counter", () => {
    clearWindsurfSessionTurnCountersForTest()
    expect(nextWindsurfSessionTurnIndex("s")).toBe(0)
    expect(nextWindsurfSessionTurnIndex("s")).toBe(1)
    resetWindsurfSessionTurnIndex("s")
    expect(nextWindsurfSessionTurnIndex("s")).toBe(0)
  })
})

describe("windsurf field 15 wire encoding", () => {
  test("first turn omits f15.2 and marks the user-turn boundary", () => {
    clearWindsurfSessionTurnCountersForTest()
    const f15 = buildFor("cascade-f15-first")
    expect(f15.get(1)).toBe("cascade-f15-first")
    expect(f15.has(2)).toBe(false)
    expect(f15.get(3)).toBe(4)
    expect(f15.get(4)).toBe(14)
  })

  test("second turn carries f15.2 = 1", () => {
    clearWindsurfSessionTurnCountersForTest()
    buildFor("cascade-f15-second")
    const f15 = buildFor("cascade-f15-second")
    expect(f15.get(2)).toBe(1)
  })

  test("explicit turnIndex reuses the ordinal (retry semantics)", () => {
    clearWindsurfSessionTurnCountersForTest()
    const first = buildFor("cascade-f15-retry")
    const retry = buildFor("cascade-f15-retry", 0)
    expect(first.has(2)).toBe(false)
    expect(retry.has(2)).toBe(false)
    // The retry must not consume the counter: the next new turn is still 1.
    expect(buildFor("cascade-f15-retry").get(2)).toBe(1)
  })

  test("assistant-last history omits f15.4", () => {
    clearWindsurfSessionTurnCountersForTest()
    const framed = buildRequest({
      payload: {
        model: "swe-test",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
        stream: true,
      },
      apiKey: "test-key",
      requestModel: "MODEL_TEST",
      cascadeId: "cascade-f15-assistant-last",
    })
    const f15 = field15Entries(decodeFramedPayload(framed))
    expect(f15.has(4)).toBe(false)
  })
})
