import { afterEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import {
  createCodexResponsesOnce,
  finalizeCodexOutboundBody,
} from "~/services/codex/create-responses-once"
import {
  clearCodexTranscript,
  codexTranscriptKey,
  setCodexTranscript,
} from "~/services/codex/ws-transcript-cache"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeAccount(): Account {
  return {
    id: "codex-1",
    label: "codex",
    provider: "codex",
    credentials: {
      type: "oauth",
      accessToken: "tok",
      accountId: "acct-1",
      expiresAt: Date.now() + 100_000,
    },
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
  }
}

function sseOkBody(): Response {
  return new Response(
    [
      'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
      "",
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

/** Runs one createCodexResponsesOnce call and returns the posted upstream body. */
async function capturePostedBody(
  payload: Record<string, unknown>,
  opts: {
    headers?: Record<string, string>
    /**
     * Transcript recovery fails closed without a tenant scope, so any test
     * exercising the replay path must model a real scoped caller (both route
     * handlers always supply one — see ~/lib/request-scope).
     */
    transcriptScopeId?: string
  } = {},
): Promise<Record<string, unknown>> {
  let postedBody: Record<string, unknown> | undefined
  globalThis.fetch = ((_url: unknown, init: RequestInit) => {
    postedBody = JSON.parse(init.body as string) as Record<string, unknown>
    return Promise.resolve(sseOkBody())
  }) as typeof fetch

  const stream = await createCodexResponsesOnce(
    makeAccount(),
    payload as never,
    undefined,
    {
      forwardedHeaders: opts.headers ?? {},
      transcriptScopeId: opts.transcriptScopeId,
    },
  )
  for await (const _e of stream as AsyncIterable<unknown>) {
    // drain
  }
  if (!postedBody) throw new Error("upstream body was never captured")
  return postedBody
}

describe("codex request compatibility (CPA parity)", () => {
  test("parallel_tool_calls: non-lite client explicit false is preserved with tools", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      parallel_tool_calls: false,
      tools: [{ type: "function", name: "lookup" }],
    })
    expect(body.parallel_tool_calls).toBe(false)
  })

  test("parallel_tool_calls: non-lite with no tools omits the field", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      parallel_tool_calls: false,
    })
    expect(Object.hasOwn(body, "parallel_tool_calls")).toBe(false)
  })

  test("parallel_tool_calls: non-lite default (no explicit value) with tools is true", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      tools: [{ type: "function", name: "lookup" }],
    })
    expect(body.parallel_tool_calls).toBe(true)
  })

  test("parallel_tool_calls: responses-lite forces false even with tools", async () => {
    const body = await capturePostedBody(
      {
        model: "gpt-5",
        input: [{ type: "message", role: "user", content: "hi" }],
        stream: true,
        parallel_tool_calls: true,
        tools: [{ type: "function", name: "lookup" }],
      },
      { headers: { "x-openai-internal-codex-responses-lite": "true" } },
    )
    expect(body.parallel_tool_calls).toBe(false)
  })

  test("max_output_tokens / max_completion_tokens stay stripped (upstream rejects them)", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      max_output_tokens: 64,
      max_completion_tokens: 128,
    })
    expect(Object.hasOwn(body, "max_output_tokens")).toBe(false)
    expect(Object.hasOwn(body, "max_completion_tokens")).toBe(false)
  })

  test("role system is rewritten to developer without mutating the payload", async () => {
    const payload = {
      model: "gpt-5",
      input: [
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "be terse" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
      stream: true,
    }
    const body = await capturePostedBody(payload)
    expect(body.input).toEqual([
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "be terse" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ])
    // Caller's payload untouched.
    expect((payload.input[0] as { role: string }).role).toBe("system")
  })

  test("stream_options keeps only reasoning_summary_delivery", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      stream_options: {
        include_usage: true,
        reasoning_summary_delivery: "sequential_cutoff",
      },
    })
    expect(body.stream_options).toEqual({
      reasoning_summary_delivery: "sequential_cutoff",
    })
  })

  test("service_tier: priority is kept, other values are stripped", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      service_tier: "standard",
    })
    expect(Object.hasOwn(body, "service_tier")).toBe(false)

    const body2 = await capturePostedBody({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      service_tier: "priority",
    })
    expect(body2.service_tier).toBe("priority")
  })

  test("generate is stripped from the HTTP body", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      generate: { kind: "spawn_agent" },
    })
    expect(Object.hasOwn(body, "generate")).toBe(false)
  })

  // `generate` is WebSocket-only (CPA deletes it only on the HTTP path). The
  // HTTP-capture harness above cannot observe the WS-bound body, so exercise
  // finalizeCodexOutboundBody's transport branch directly. Like the rest of
  // this module, the strip is done by setting the field to `undefined` and
  // relying on JSON.stringify to drop it on the actual wire (see the
  // "generate is stripped" test above), so assert on the value here rather
  // than `Object.hasOwn`.
  test("finalizeCodexOutboundBody keeps generate for ws transport, strips for http", () => {
    const body = {
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      generate: { kind: "spawn_agent" },
    }
    expect(finalizeCodexOutboundBody(body, "ws").generate).toEqual({
      kind: "spawn_agent",
    })
    expect(finalizeCodexOutboundBody(body, "http").generate).toBeUndefined()
  })

  // The chained-replay body rebuilds `input` from the raw client delta plus the
  // transcript, so it does not inherit the normalization applied to
  // `upstreamBody.input`. Both halves must still be rewritten.
  test("chained HTTP replay body rewrites role system in transcript and delta", async () => {
    const sessionKey = "codex-replay-system-role"
    const scopeId = "user:replay-system-role"
    const key = codexTranscriptKey(`${scopeId}::${sessionKey}`)
    setCodexTranscript(key, [
      {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "cached system turn" }],
      },
    ])

    try {
      const body = await capturePostedBody(
        {
          model: "gpt-5",
          stream: true,
          prompt_cache_key: sessionKey,
          previous_response_id: "resp_prev",
          input: [
            {
              type: "message",
              role: "system",
              content: [{ type: "input_text", text: "delta system turn" }],
            },
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "hi" }],
            },
          ],
        },
        { transcriptScopeId: scopeId },
      )

      const roles = (body.input as Array<{ role?: string }>).map(
        (item) => item.role,
      )
      expect(roles).toEqual(["developer", "developer", "user"])
      // HTTP never chains; the replay body carries the full input instead.
      expect(Object.hasOwn(body, "previous_response_id")).toBe(false)
    } finally {
      clearCodexTranscript(key)
    }
  })

  // P0 invariant: every body sent upstream passes through the single
  // `finalizeCodexOutboundBody` boundary. This is a general parity check
  // (not an enumeration of known fields) so a future field-level transform
  // that gets added to only one of the two body-construction paths (primary
  // vs. transcript-replay) fails this test instead of silently diverging —
  // the same failure shape as the system-role bug fixed above.
  test("replay body matches the primary body field-by-field except input and previous_response_id", async () => {
    const EXEMPT_FIELDS = new Set(["input", "previous_response_id"])
    const sessionKey = "codex-invariant-session"
    const scopeId = "user:codex-invariant"
    const basePayload = {
      model: "gpt-5",
      stream: true,
      prompt_cache_key: sessionKey,
      tools: [{ type: "function", name: "lookup" }],
      parallel_tool_calls: true,
      service_tier: "priority",
      stream_options: {
        reasoning_summary_delivery: "sequential_cutoff",
        include_usage: true,
      },
    }

    const primaryBody = await capturePostedBody(
      {
        ...basePayload,
        input: [{ type: "message", role: "user", content: "hi" }],
      },
      { transcriptScopeId: scopeId },
    )

    const key = codexTranscriptKey(`${scopeId}::${sessionKey}`)
    setCodexTranscript(key, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "cached" }],
      },
    ])
    let replayBody: Record<string, unknown>
    try {
      replayBody = await capturePostedBody(
        {
          ...basePayload,
          previous_response_id: "resp_prev",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "hi" }],
            },
          ],
        },
        { transcriptScopeId: scopeId },
      )
    } finally {
      clearCodexTranscript(key)
    }

    const primaryKeys = Object.keys(primaryBody).filter(
      (k) => !EXEMPT_FIELDS.has(k),
    )
    const replayKeys = Object.keys(replayBody).filter(
      (k) => !EXEMPT_FIELDS.has(k),
    )
    expect(new Set(replayKeys)).toEqual(new Set(primaryKeys))
    for (const field of primaryKeys) {
      expect(replayBody[field]).toEqual(primaryBody[field])
    }
  })
})
