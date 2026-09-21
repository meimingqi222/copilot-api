import { afterEach, describe, expect, test } from "bun:test"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { UpstreamTransportError } from "~/lib/error"
import { createResponsesErrorPayload } from "~/routes/responses/handler"
import { createCodexResponsesOnce } from "~/services/codex/create-responses-once"
import {
  chainedHttpCodexRequestError,
  pruneUnansweredToolCalls,
  stripReasoningItems,
} from "~/services/codex/upstream-body"
import {
  clearCodexTranscriptsForTest,
  codexTranscriptKey,
  setCodexTranscript,
} from "~/services/codex/ws-transcript-cache"

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

describe("pruneUnansweredToolCalls", () => {
  test("drops a tool call with no matching output", () => {
    // The upstream 400 this exists to prevent: a transcript rebuilt from the
    // cache can keep a call the client never answered (interrupted turn).
    const input = [
      { type: "message", role: "user", content: "hi" },
      { type: "custom_tool_call", call_id: "call_1", name: "shell" },
      { type: "message", role: "user", content: "next" },
    ]
    expect(pruneUnansweredToolCalls(input)).toEqual([
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "user", content: "next" },
    ])
  })

  test("keeps a call that has its matching output", () => {
    const input = [
      { type: "function_call", call_id: "call_1", name: "f" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]
    expect(pruneUnansweredToolCalls(input)).toEqual(input)
  })

  test("pairs by type: a function output does not answer a custom call", () => {
    const input = [
      { type: "custom_tool_call", call_id: "call_1", name: "shell" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]
    // The custom call stays unanswered and is pruned; the output is kept
    // (pruning it would just be the *other* upstream 400).
    expect(pruneUnansweredToolCalls(input)).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ])
  })

  test("keeps calls without a call_id rather than guessing", () => {
    const input = [
      { type: "custom_tool_call", name: "shell" },
      { type: "message", role: "user", content: "hi" },
    ]
    expect(pruneUnansweredToolCalls(input)).toEqual(input)
  })

  test("returns the same array reference when nothing is pruned", () => {
    const input = [
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", call_id: "c1", name: "f" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ]
    expect(pruneUnansweredToolCalls(input)).toBe(input)
  })

  test("drops every unanswered call when none are answered", () => {
    const input = [
      { type: "custom_tool_call", call_id: "c1", name: "shell" },
      { type: "function_call", call_id: "c2", name: "f" },
    ]
    expect(pruneUnansweredToolCalls(input)).toEqual([])
  })
})

function makeCodexSubject(): {
  connection: ProviderConnection
  credential: ApiCredential
} {
  const credential: ApiCredential = {
    id: "cred-1",
    authMode: "bearer",
    value: "token",
    enabled: true,
    status: "ready",
    createdAt: Date.now(),
    refresherType: "oauth-token",
    context: { oauthAccountId: "acct-1" },
  }
  return {
    credential,
    connection: {
      id: "codex-1",
      name: "codex",
      protocol: "codex-native",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      priority: 0,
      createdAt: Date.now(),
      credentials: [credential],
      metadata: { provider: "codex" },
    },
  }
}

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

    const stream = await createCodexResponsesOnce(
      makeCodexSubject(),
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

    const context = {
      downstreamWebsocket: true,
      executionSessionId: "fresh-socket",
      transcriptScopeId: "test-scope",
      forwardedHeaders: { session_id: "tool-session" },
      forceUpstreamHttp: true,
    }
    const first = await createCodexResponsesOnce(
      makeCodexSubject(),
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
      makeCodexSubject(),
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

  test("prunes a cached tool call the client never answered", async () => {
    // The regression this exists for: the model emitted a custom tool call,
    // the turn was interrupted before its output existed, and the transcript
    // cache kept the call. Replaying that transcript verbatim sends a call
    // with no output, and the upstream rejects the whole turn with
    // "No tool output found for custom tool call ...". The replay body is
    // assembled by us, so we prune the half-pair we own.
    const sessionId = "unanswered-session"
    setCodexTranscript(codexTranscriptKey(`test-scope::${sessionId}`), [
      { type: "message", role: "user", content: "run pwd" },
      {
        id: "ctc_1",
        type: "custom_tool_call",
        call_id: "call_never_answered",
        name: "shell",
        input: "pwd",
      },
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
            'data: {"type":"response.completed","response":{"id":"resp_2","status":"completed","output":[]}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      )
    }) as typeof fetch

    const stream = await createCodexResponsesOnce(
      makeCodexSubject(),
      {
        model: "gpt-5",
        input: [
          { type: "message", role: "user", content: "continue" } as never,
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
      // consume the recovery stream
    }

    // The cached call had no output anywhere, so the replay must not carry it.
    expect(postedBody?.input).toEqual([
      { type: "message", role: "user", content: "run pwd" },
      { type: "message", role: "user", content: "continue" },
    ])
  })
})
