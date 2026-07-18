import { afterEach, describe, expect, test } from "bun:test"

import {
  clearCodexTranscript,
  clearCodexTranscriptsForTest,
  clearResponsesTranscriptsByExecutionId,
  codexTranscriptKey,
  getCodexTranscript,
  getCodexTranscriptCountForTest,
  setCodexTranscript,
} from "~/services/codex/ws-transcript-cache"
import { selectUpstreamWsBody } from "~/services/responses/upstream-ws"

afterEach(() => {
  clearCodexTranscriptsForTest()
})

describe("codexTranscriptKey", () => {
  test("combines execution session id and model", () => {
    expect(codexTranscriptKey("sess-1", "gpt-5")).toBe("codex::sess-1::gpt-5")
  })
})

describe("transcript get/set", () => {
  test("stores and returns full input", () => {
    const key = codexTranscriptKey("sess-1", "gpt-5")
    const items = [{ type: "message", role: "user", content: "hi" }]
    setCodexTranscript(key, items)
    expect(getCodexTranscript(key)).toEqual(items)
    expect(getCodexTranscriptCountForTest()).toBe(1)
  })

  test("missing key returns undefined", () => {
    expect(getCodexTranscript("nope::gpt-5")).toBeUndefined()
  })

  test("oversized transcript is dropped, not stored", () => {
    const key = codexTranscriptKey("sess-big", "gpt-5")
    const huge = Array.from({ length: 4001 }, (_, i) => ({ i }))
    setCodexTranscript(key, huge)
    expect(getCodexTranscript(key)).toBeUndefined()
    expect(getCodexTranscriptCountForTest()).toBe(0)
  })

  test("oversized transcript deletes an existing entry", () => {
    const key = codexTranscriptKey("sess-1", "gpt-5")
    setCodexTranscript(key, [{ a: 1 }])
    expect(getCodexTranscript(key)).toBeDefined()
    const huge = Array.from({ length: 5000 }, (_, i) => ({ i }))
    setCodexTranscript(key, huge)
    expect(getCodexTranscript(key)).toBeUndefined()
  })
})

describe("transcript clearing", () => {
  test("clearCodexTranscript removes a single exact key", () => {
    const a = codexTranscriptKey("sess-1", "gpt-5")
    const b = codexTranscriptKey("sess-1", "gpt-5-mini")
    setCodexTranscript(a, [{ a: 1 }])
    setCodexTranscript(b, [{ b: 1 }])
    clearCodexTranscript(a)
    expect(getCodexTranscript(a)).toBeUndefined()
    expect(getCodexTranscript(b)).toBeDefined()
  })

  test("clearResponsesTranscriptsByExecutionId removes all models for a session", () => {
    setCodexTranscript(codexTranscriptKey("sess-1", "gpt-5"), [{ a: 1 }])
    setCodexTranscript(codexTranscriptKey("sess-1", "gpt-5-mini"), [{ b: 1 }])
    setCodexTranscript(codexTranscriptKey("sess-2", "gpt-5"), [{ c: 1 }])
    const cleared = clearResponsesTranscriptsByExecutionId("sess-1")
    expect(cleared).toBe(2)
    expect(
      getCodexTranscript(codexTranscriptKey("sess-1", "gpt-5")),
    ).toBeUndefined()
    expect(
      getCodexTranscript(codexTranscriptKey("sess-1", "gpt-5-mini")),
    ).toBeUndefined()
    expect(
      getCodexTranscript(codexTranscriptKey("sess-2", "gpt-5")),
    ).toBeDefined()
  })

  test("clearResponsesTranscriptsByExecutionId ignores empty id", () => {
    setCodexTranscript(codexTranscriptKey("sess-1", "gpt-5"), [{ a: 1 }])
    expect(clearResponsesTranscriptsByExecutionId("  ")).toBe(0)
    expect(getCodexTranscriptCountForTest()).toBe(1)
  })

  test("prefix match does not clear a lookalike session id", () => {
    setCodexTranscript(codexTranscriptKey("sess-1", "gpt-5"), [{ a: 1 }])
    setCodexTranscript(codexTranscriptKey("sess-10", "gpt-5"), [{ b: 1 }])
    const cleared = clearResponsesTranscriptsByExecutionId("sess-1")
    expect(cleared).toBe(1)
    expect(
      getCodexTranscript(codexTranscriptKey("sess-10", "gpt-5")),
    ).toBeDefined()
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
