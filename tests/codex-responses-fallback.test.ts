import { afterEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import { UpstreamTransportError } from "~/lib/error"
import { createResponsesErrorPayload } from "~/routes/responses/handler"
import { createCodexResponsesOnce } from "~/services/codex/create-responses-once"
import {
  chainedHttpCodexRequestError,
  stripReasoningItems,
} from "~/services/codex/upstream-body"
import {
  clearCodexTranscriptsForTest,
  codexTranscriptKey,
  setCodexTranscript,
} from "~/services/codex/ws-transcript-cache"
import { selectUpstreamWsBody } from "~/services/responses/upstream-ws"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  clearCodexTranscriptsForTest()
})

describe("chainedHttpCodexRequestError", () => {
  test("transport failures carry a retryable upstream WebSocket status", () => {
    const message = "codex websockets: upstream socket closed unexpectedly"
    expect(
      createResponsesErrorPayload(new UpstreamTransportError(message)),
    ).toEqual({
      type: "error",
      status: 503,
      error: {
        code: "upstream_transport_error",
        message,
        retryable: true,
        type: "upstream_error",
      },
    })
  })

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

  test("WS/SSE error event preserves the client replay handshake", () => {
    expect(createResponsesErrorPayload(chainedHttpCodexRequestError())).toEqual(
      {
        type: "error",
        status: 409,
        error: {
          code: "previous_response_not_found",
          message:
            "Chained Codex requests require WebSocket transport or full replay.",
          type: "invalid_request_error",
        },
      },
    )
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

describe("chained HTTP recovery", () => {
  test("expands a previous_response_id delta from the stable transcript", async () => {
    const sessionId = "stable-session"
    setCodexTranscript(codexTranscriptKey(`test-scope::${sessionId}`), [
      { type: "message", role: "user", content: "first" },
      { type: "message", role: "assistant", content: "answer" },
    ])

    let postedBody: Record<string, unknown> | undefined
    globalThis.fetch = ((_url, init) => {
      if (typeof init?.body !== "string") {
        throw new TypeError("expected string request body")
      }
      postedBody = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(
        new Response(
          [
            'data: {"type":"response.created","response":{"id":"resp_2","status":"in_progress"}}',
            "",
            'data: {"type":"response.completed","response":{"id":"resp_2","status":"completed","output":[]}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      )
    }) as typeof fetch

    const account: Account = {
      id: "codex-1",
      label: "codex",
      provider: "codex",
      credentials: { accessToken: "token", accountId: "acct-1" },
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
    }
    const stream = await createCodexResponsesOnce(
      account,
      {
        model: "gpt-5",
        input: [
          {
            type: "function_call_output",
            call_id: "call-1",
            output: "ok",
          },
        ],
        previous_response_id: "resp_1",
        stream: true,
      },
      undefined,
      {
        downstreamWebsocket: true,
        executionSessionId: "new-socket",
        transcriptScopeId: "test-scope",
        forwardedHeaders: { session_id: sessionId },
        forceUpstreamHttp: true,
      },
    )
    for await (const _event of stream as AsyncIterable<unknown>) {
      // consume the recovery stream so transcript recording also completes
    }

    expect(postedBody?.previous_response_id).toBeUndefined()
    expect(postedBody?.input).toEqual([
      { type: "message", role: "user", content: "first" },
      { type: "message", role: "assistant", content: "answer" },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "ok",
      },
    ])
  })

  test("recovers a tool call collected from output_item.done after a fresh connection", async () => {
    const postedBodies: Array<Record<string, unknown>> = []
    let requestIndex = 0
    globalThis.fetch = ((_url, init) => {
      if (typeof init?.body !== "string") {
        throw new TypeError("expected string request body")
      }
      postedBodies.push(JSON.parse(init.body) as Record<string, unknown>)
      requestIndex += 1
      const responseId = `resp_${requestIndex}`
      const events =
        requestIndex === 1 ?
          [
            `data: {"type":"response.created","response":{"id":"${responseId}","status":"in_progress"}}`,
            "",
            `data: {"type":"response.output_item.done","response_id":"${responseId}","output_index":0,"item":{"id":"ctc_1","type":"custom_tool_call","call_id":"call_1","name":"shell","input":"pwd"}}`,
            "",
            `data: {"type":"response.completed","response":{"id":"${responseId}","status":"completed","output":[]}}`,
            "",
            "data: [DONE]",
            "",
          ]
        : [
            `data: {"type":"response.completed","response":{"id":"${responseId}","status":"completed","output":[]}}`,
            "",
            "data: [DONE]",
            "",
          ]
      return Promise.resolve(
        new Response(events.join("\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }) as typeof fetch

    const account: Account = {
      id: "codex-1",
      label: "codex",
      provider: "codex",
      credentials: { accessToken: "token", accountId: "acct-1" },
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
    }
    const context = {
      downstreamWebsocket: true,
      executionSessionId: "fresh-socket",
      transcriptScopeId: "test-scope",
      forwardedHeaders: { session_id: "tool-session" },
      forceUpstreamHttp: true,
    }
    const first = await createCodexResponsesOnce(
      account,
      {
        model: "gpt-5",
        input: [{ type: "message", role: "user", content: "run pwd" } as never],
        stream: true,
      },
      undefined,
      context,
    )
    for await (const _event of first as AsyncIterable<unknown>) {
      // Consume completion so the transcript checkpoint is written.
    }

    const second = await createCodexResponsesOnce(
      account,
      {
        model: "gpt-5",
        input: [
          {
            type: "custom_tool_call_output",
            call_id: "call_1",
            output: "ok",
          } as never,
        ],
        previous_response_id: "resp_1",
        stream: true,
      },
      undefined,
      context,
    )
    for await (const _event of second as AsyncIterable<unknown>) {
      // Consume the recovery turn.
    }

    expect(postedBodies[1]?.previous_response_id).toBeUndefined()
    expect(postedBodies[1]?.input).toEqual([
      { type: "message", role: "user", content: "run pwd" },
      {
        id: "ctc_1",
        type: "custom_tool_call",
        call_id: "call_1",
        name: "shell",
        input: "pwd",
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: "ok",
      },
    ])
  })
})
