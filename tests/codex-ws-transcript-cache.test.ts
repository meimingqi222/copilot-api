import { afterEach, describe, expect, test } from "bun:test"

import {
  appendCodexTranscript,
  buildResponsesTranscriptInput,
  clearCodexTranscript,
  clearCodexTranscriptsForTest,
  clearResponsesTranscriptsByExecutionId,
  codexTranscriptKey,
  getCodexTranscript,
  getCodexTranscriptBytesForTest,
  getCodexTranscriptCountForTest,
  resolveResponsesTranscriptSessionId,
  resolveSocketResponsesTranscriptSessionId,
  setCodexTranscript,
} from "~/services/codex/ws-transcript-cache"
import { selectUpstreamWsBody } from "~/services/responses/upstream-ws"

afterEach(() => {
  clearCodexTranscriptsForTest()
})

describe("codexTranscriptKey", () => {
  test("keys by execution session only (conversation-scoped, not model)", () => {
    // Model is deliberately NOT part of the key: Codex Desktop alternates
    // models (gpt-5.6-sol ↔ gpt-5.6-terra) within one conversation, and a
    // per-model key would break the fresh-socket full replay after an
    // account switch / socket redial.
    expect(codexTranscriptKey("sess-1")).toBe("codex::sess-1")
  })

  test("prefers a stable client session across socket reconnects", () => {
    expect(resolveResponsesTranscriptSessionId("socket-2", " session-1 ")).toBe(
      "session-1",
    )
    expect(
      resolveResponsesTranscriptSessionId("socket-2", "session-1", "user:1"),
    ).toBe("user:1::session-1")
    expect(resolveResponsesTranscriptSessionId("socket-2")).toBe("socket-2")
  })
})

describe("transcript get/set", () => {
  test("stores and returns full input", () => {
    const key = codexTranscriptKey("sess-1")
    const items = [{ type: "message", role: "user", content: "hi" }]
    const result = setCodexTranscript(key, items)
    expect(getCodexTranscript(key)).toEqual(items)
    expect(getCodexTranscriptCountForTest()).toBe(1)
    expect(result).toEqual({
      stored: true,
      entryBytes: getCodexTranscriptBytesForTest(),
      totalBytes: getCodexTranscriptBytesForTest(),
      entries: 1,
    })
  })

  test("missing key returns undefined", () => {
    expect(getCodexTranscript("nope::gpt-5")).toBeUndefined()
  })

  test("buildResponsesTranscriptInput dedupes delta items against the cache", () => {
    const cached = [
      { type: "message", id: "msg_1", role: "user", content: "old" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "read" },
    ]
    const delta = [
      // Same ids re-sent by the client → delta version wins, no duplicates.
      { type: "message", id: "msg_1", role: "user", content: "updated" },
      { type: "custom_tool_call_output", id: "ctco_1", call_id: "call_1" },
    ]
    const merged = buildResponsesTranscriptInput(cached, delta, false)
    // The stale msg_1 from the cache is dropped; fc_1 (no delta twin) and
    // both delta items survive exactly once.
    expect(merged).toEqual([cached[1], ...delta])
    expect(
      merged.filter((item) => (item as { id?: string }).id === "msg_1"),
    ).toHaveLength(1)
  })

  test("buildResponsesTranscriptInput keeps cache items without a delta twin", () => {
    const cached = [
      { type: "message", id: "msg_1", role: "user", content: "cached" },
    ]
    const delta = [
      { type: "custom_tool_call_output", id: "ctco_1", call_id: "call_1" },
    ]
    const merged = buildResponsesTranscriptInput(cached, delta, false)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual(cached[0])
    expect(merged[1]).toEqual(delta[0])
  })

  test("dedupes id-less tool outputs by type and call_id", () => {
    const cached = [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "stale",
      },
    ]
    const delta = [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "latest",
      },
    ]

    expect(buildResponsesTranscriptInput(cached, delta, false)).toEqual(delta)
  })

  test("does not collapse different tool output types sharing a call_id", () => {
    const cached = [
      {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: "custom",
      },
    ]
    const delta = [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "function",
      },
    ]

    expect(buildResponsesTranscriptInput(cached, delta, false)).toEqual([
      ...cached,
      ...delta,
    ])
  })

  test("buildResponsesTranscriptInput copies when tracking without a cache", () => {
    const delta = [{ type: "message", role: "user", content: "hi" }]
    const tracked = buildResponsesTranscriptInput(undefined, delta, true)
    expect(tracked).toEqual(delta)
    expect(tracked).not.toBe(delta)
    const untracked = buildResponsesTranscriptInput(undefined, delta, false)
    expect(untracked).toBe(delta)
  })

  // P3: appendCodexTranscript must never mutate the caller's array in place.
  // buildResponsesTranscriptInput can return the caller's own `payload.input`
  // array by reference for an untracked turn; if append pushed onto it, an
  // upstream response's output items would leak into the caller's payload.
  test("appendCodexTranscript does not mutate the caller's fullInput array", () => {
    const key = codexTranscriptKey("sess-append")
    const callerOwnedInput = [{ type: "message", role: "user", content: "hi" }]
    const originalLength = callerOwnedInput.length

    const result = appendCodexTranscript(key, callerOwnedInput, [
      { type: "message", role: "assistant", content: "hello" },
    ])

    expect(callerOwnedInput.length).toBe(originalLength)
    expect(result.stored).toBe(true)
    expect(getCodexTranscript(key)).toEqual([
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "hello" },
    ])
  })

  test("oversized transcript is dropped, not stored", () => {
    const key = codexTranscriptKey("sess-big")
    const huge = Array.from({ length: 4001 }, (_, i) => ({ i }))
    const result = setCodexTranscript(key, huge)
    expect(getCodexTranscript(key)).toBeUndefined()
    expect(getCodexTranscriptCountForTest()).toBe(0)
    expect(result.stored).toBe(false)
    expect(result.entries).toBe(0)
  })

  test("oversized transcript deletes an existing entry", () => {
    const key = codexTranscriptKey("sess-1")
    setCodexTranscript(key, [{ a: 1 }])
    expect(getCodexTranscript(key)).toBeDefined()
    const huge = Array.from({ length: 5000 }, (_, i) => ({ i }))
    setCodexTranscript(key, huge)
    expect(getCodexTranscript(key)).toBeUndefined()
    expect(getCodexTranscriptBytesForTest()).toBe(0)
  })

  test("one oversized item is rejected by the byte cap", () => {
    const key = codexTranscriptKey("sess-bytes")
    setCodexTranscript(key, [{ content: "x".repeat(8 * 1024 * 1024) }])
    expect(getCodexTranscript(key)).toBeUndefined()
    expect(getCodexTranscriptBytesForTest()).toBe(0)
  })
})

describe("transcript clearing", () => {
  test("clearCodexTranscript removes a single exact key", () => {
    const a = codexTranscriptKey("sess-1")
    const b = codexTranscriptKey("sess-2")
    setCodexTranscript(a, [{ a: 1 }])
    setCodexTranscript(b, [{ b: 1 }])
    clearCodexTranscript(a)
    expect(getCodexTranscript(a)).toBeUndefined()
    expect(getCodexTranscript(b)).toBeDefined()
  })

  test("one transcript entry per session regardless of model", () => {
    // Key is conversation-scoped; writes from different model turns land on
    // the same entry so a cross-model replay sees the full conversation.
    setCodexTranscript(codexTranscriptKey("sess-1"), [{ a: 1 }])
    setCodexTranscript(codexTranscriptKey("sess-1"), [{ a: 1 }, { b: 1 }])
    setCodexTranscript(codexTranscriptKey("sess-2"), [{ c: 1 }])
    const cleared = clearResponsesTranscriptsByExecutionId("sess-1")
    expect(cleared).toBe(1)
    expect(getCodexTranscript(codexTranscriptKey("sess-1"))).toBeUndefined()
    expect(getCodexTranscript(codexTranscriptKey("sess-2"))).toBeDefined()
  })

  test("clearResponsesTranscriptsByExecutionId ignores empty id", () => {
    setCodexTranscript(codexTranscriptKey("sess-1"), [{ a: 1 }])
    expect(clearResponsesTranscriptsByExecutionId("  ")).toBe(0)
    expect(getCodexTranscriptCountForTest()).toBe(1)
  })

  test("prefix match does not clear a lookalike session id", () => {
    setCodexTranscript(codexTranscriptKey("sess-1"), [{ a: 1 }])
    setCodexTranscript(codexTranscriptKey("sess-10"), [{ b: 1 }])
    const cleared = clearResponsesTranscriptsByExecutionId("sess-1")
    expect(cleared).toBe(1)
    expect(getCodexTranscript(codexTranscriptKey("sess-10"))).toBeDefined()
  })

  test("socket execution id is not mistaken for a stable scoped session", () => {
    const executionId = "socket-123"
    const resolved = resolveSocketResponsesTranscriptSessionId(
      executionId,
      executionId,
      "user:1",
    )
    const key = codexTranscriptKey(resolved)
    setCodexTranscript(key, [{ a: 1 }])

    expect(resolved).toBe(executionId)
    expect(clearResponsesTranscriptsByExecutionId(executionId)).toBe(1)
    expect(getCodexTranscript(key)).toBeUndefined()
  })
})

describe("selectUpstreamWsBody", () => {
  const incrementalBody = {
    type: "response.create",
    model: "gpt-5",
    previous_response_id: "resp_1",
    input: [{ type: "message", role: "user", content: "delta" }],
  }
  const fallbackFullInputBody = {
    model: "gpt-5",
    store: false,
    input: [
      { type: "message", role: "user", content: "first" },
      { type: "message", role: "assistant", content: "answer" },
      { type: "message", role: "user", content: "delta" },
    ],
  }

  test("fresh socket + chaining + fallback replays full input", () => {
    const { body, usedFallback } = selectUpstreamWsBody({
      openedFresh: true,
      previousResponseId: "resp_1",
      incrementalBody,
      fallbackFullInputBody,
      provider: "codex",
    })
    expect(usedFallback).toBe(true)
    expect(body.type).toBe("response.create")
    expect(body.previous_response_id).toBeUndefined()
    expect(Array.isArray(body.input) ? body.input.length : 0).toBe(3)
  })

  test("reused live socket keeps incremental chaining", () => {
    const { body, usedFallback } = selectUpstreamWsBody({
      openedFresh: false,
      previousResponseId: "resp_1",
      incrementalBody,
      fallbackFullInputBody,
      provider: "codex",
    })
    expect(usedFallback).toBe(false)
    expect(body).toBe(incrementalBody)
    expect(body.previous_response_id).toBe("resp_1")
  })

  test("fresh socket without a fallback body sends incremental", () => {
    const { body, usedFallback } = selectUpstreamWsBody({
      openedFresh: true,
      previousResponseId: "resp_1",
      incrementalBody,
      fallbackFullInputBody: undefined,
      provider: "codex",
    })
    expect(usedFallback).toBe(false)
    expect(body).toBe(incrementalBody)
  })

  test("fresh socket without chaining sends incremental", () => {
    const { body, usedFallback } = selectUpstreamWsBody({
      openedFresh: true,
      previousResponseId: undefined,
      incrementalBody,
      fallbackFullInputBody,
      provider: "codex",
    })
    expect(usedFallback).toBe(false)
    expect(body).toBe(incrementalBody)
  })
})
