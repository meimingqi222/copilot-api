import { describe, expect, test } from "bun:test"

import {
  chainedHttpCodexRequestError,
  stripReasoningItems,
} from "~/services/codex/create-responses-once"
import { selectUpstreamWsBody } from "~/services/responses/upstream-ws"

describe("chainedHttpCodexRequestError", () => {
  test("carries the previous_response_not_found marker and a 409 status", () => {
    const err = chainedHttpCodexRequestError()
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("previous_response_not_found")
    expect(err.response.status).toBe(409)
  })

  test("error body carries a machine-readable code for clients", () => {
    const err = chainedHttpCodexRequestError()
    expect(err.responseBody).toBeTruthy()
    const body = JSON.parse(err.responseBody) as {
      error: { code: string; type: string }
    }
    expect(body.error.code).toBe("previous_response_not_found")
    expect(body.error.type).toBe("invalid_request_error")
  })
})

describe("stripReasoningItems", () => {
  test("drops every reasoning item, keeps conversation items in order", () => {
    const input = [
      { type: "message", role: "user", content: "hi" },
      { type: "reasoning", encrypted_content: "AAA" },
      { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
      { type: "reasoning", encrypted_content: "BBB" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]
    expect(stripReasoningItems(input)).toEqual([
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ])
  })

  test("returns items unchanged when there is no reasoning", () => {
    const input = [
      { type: "message", role: "user", content: "hi" },
      { type: "custom_tool_call_output", call_id: "c1", output: "x" },
    ]
    expect(stripReasoningItems(input)).toEqual(input)
  })

  test("tolerates null / non-object entries", () => {
    const input = [null, 42, { type: "reasoning" }, { type: "message" }]
    expect(stripReasoningItems(input)).toEqual([null, 42, { type: "message" }])
  })
})

describe("selectUpstreamWsBody fallback", () => {
  test("fresh socket + chaining replays the self-contained full input", () => {
    // fallbackFullInputBody is already reasoning-stripped by the caller and has
    // previous_response_id dropped.
    const fallback = {
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      previous_response_id: undefined,
    }
    const { body, usedFallback } = selectUpstreamWsBody({
      openedFresh: true,
      previousResponseId: "resp_1",
      incrementalBody: {
        model: "gpt-5",
        input: [{ type: "function_call_output", call_id: "c1", output: "ok" }],
        previous_response_id: "resp_1",
      },
      fallbackFullInputBody: fallback,
      provider: "codex",
    })
    expect(usedFallback).toBe(true)
    expect(body.type).toBe("response.create")
    expect(body.previous_response_id).toBeUndefined()
    expect(body.input).toEqual(fallback.input)
  })

  test("live socket keeps chaining with the incremental delta body", () => {
    const incremental = {
      model: "gpt-5",
      input: [{ type: "function_call_output", call_id: "c1", output: "ok" }],
      previous_response_id: "resp_1",
    }
    const { body, usedFallback } = selectUpstreamWsBody({
      openedFresh: false,
      previousResponseId: "resp_1",
      incrementalBody: incremental,
      fallbackFullInputBody: { model: "gpt-5", input: [{ type: "message" }] },
      provider: "codex",
    })
    expect(usedFallback).toBe(false)
    expect(body).toBe(incremental)
  })

  test("fresh socket without a fallback body sends the incremental body", () => {
    const incremental = { model: "gpt-5", input: [], previous_response_id: "" }
    const { body, usedFallback } = selectUpstreamWsBody({
      openedFresh: true,
      previousResponseId: undefined,
      incrementalBody: incremental,
      fallbackFullInputBody: undefined,
      provider: "codex",
    })
    expect(usedFallback).toBe(false)
    expect(body).toBe(incremental)
  })
})
