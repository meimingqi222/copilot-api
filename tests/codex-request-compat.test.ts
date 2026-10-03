import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { getRequestLogContext, initRequestLog } from "~/lib/request-log"
import { recordRequestedServiceTier } from "~/lib/service-tier-trace"
import { clearUpstreamWebsocketSessionsForTest } from "~/services/responses/upstream-ws"
import { loopbackTest } from "./helpers/loopback-test"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

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

function makeCodexSubject(): {
  connection: ProviderConnection
  credential: ApiCredential
} {
  const credential: ApiCredential = {
    id: "cred-1",
    authMode: "bearer",
    value: "tok",
    enabled: true,
    status: "ready",
    createdAt: Date.now(),
    refresherType: "oauth-token",
    context: {
      oauthAccountId: "acct-1",
      expiresAt: Date.now() + 100_000,
    },
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
    captureHeaders?: (headers: Headers) => void
    /**
     * Transcript recovery fails closed without a tenant scope, so any test
     * exercising the replay path must model a real scoped caller (both route
     * handlers always supply one — see ~/lib/request-scope).
     */
    transcriptScopeId?: string
  } = {},
  subject?: ReturnType<typeof makeCodexSubject>,
): Promise<Record<string, unknown>> {
  let postedBody: Record<string, unknown> | undefined
  globalThis.fetch = ((_url: unknown, init: RequestInit) => {
    postedBody = JSON.parse(init.body as string) as Record<string, unknown>
    opts.captureHeaders?.(new Headers(init.headers))
    return Promise.resolve(sseOkBody())
  }) as typeof fetch

  const stream = await createCodexResponsesOnce(
    subject ?? makeCodexSubject(),
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
  test("Fast alias and routing hint match the actual HTTP model and tier", async () => {
    for (const tier of ["fast", "priority", "default"] as const) {
      const capturedHeaders: { routingHint: string | null } = {
        routingHint: null,
      }
      const posted = await capturePostedBody(
        { model: "gpt-6.1-sol", input: "hi", stream: true, service_tier: tier },
        {
          headers: {
            "x-codex-routing-hint": "model=old-client-alias;tier=flex",
          },
          captureHeaders: (headers) => {
            capturedHeaders.routingHint = headers.get("x-codex-routing-hint")
          },
        },
      )
      expect(posted.service_tier).toBe(
        tier === "default" ? undefined : "priority",
      )
      expect(capturedHeaders.routingHint).toBe(
        tier === "default" ? "model=gpt-6.1-sol" : (
          "model=gpt-6.1-sol;tier=priority"
        ),
      )
    }
  })

  loopbackTest(
    "Codex WS handshake and body use the resolved Fast tier",
    async () => {
      const capturedHeaders: { routingHint: string | null } = {
        routingHint: null,
      }
      let posted: Record<string, unknown> | undefined
      using upstream = Bun.serve({
        port: 0,
        fetch(request, server) {
          capturedHeaders.routingHint = request.headers.get(
            "x-codex-routing-hint",
          )
          if (server.upgrade(request)) return undefined
          return new Response("Not found", { status: 404 })
        },
        websocket: {
          message(socket, message) {
            posted = JSON.parse(String(message)) as Record<string, unknown>
            socket.send(
              JSON.stringify({
                type: "response.completed",
                response: {
                  id: "resp_fast",
                  status: "completed",
                  service_tier: "fast",
                  output: [],
                },
              }),
            )
          },
        },
      })
      const subject = makeCodexSubject()
      subject.connection.metadata = {
        provider: "codex",
        settings: { baseUrl: `http://127.0.0.1:${upstream.port}` },
      }
      try {
        const result = await createCodexResponsesOnce(
          subject,
          {
            model: "gpt-6.1-sol",
            input: "hi",
            stream: true,
            service_tier: "fast",
          } as never,
          undefined,
          {
            downstreamWebsocket: true,
            executionSessionId: "fast-parity-test",
            forwardedHeaders: {
              "x-codex-routing-hint": "model=old-client-alias;tier=flex",
            },
          },
        )
        for await (const event of result as AsyncIterable<unknown>)
          expect(event).toBeDefined()
        expect(posted?.service_tier).toBe("priority")
        expect(capturedHeaders.routingHint).toBe(
          "model=gpt-6.1-sol;tier=priority",
        )
      } finally {
        clearUpstreamWebsocketSessionsForTest()
      }
    },
  )
  for (const streaming of [true, false]) {
    test(`HTTP Codex tier trace observes actual wire and response (stream=${streaming})`, async () => {
      globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        const posted = JSON.parse(init.body as string) as Record<
          string,
          unknown
        >
        expect(posted.service_tier).toBe("priority")
        const data = await sseOkBody().text()
        return new Response(
          data.replace(
            '"status":"completed","model"',
            '"status":"completed","service_tier":"default","model"',
          ),
          { headers: { "content-type": "text/event-stream" } },
        )
      }) as typeof fetch
      const app = new Hono().post("/v1/responses", async (current) => {
        initRequestLog(current)
        const payload = {
          model: "gpt-5",
          input: "test",
          stream: streaming,
          service_tier: "priority" as const,
        }
        recordRequestedServiceTier(current, payload)
        const result = await createCodexResponsesOnce(
          makeCodexSubject(),
          payload,
          undefined,
          { c: current, forceUpstreamHttp: true },
        )
        if (Symbol.asyncIterator in result)
          for await (const event of result as AsyncIterable<unknown>)
            expect(event).toBeDefined()
        return current.json(getRequestLogContext(current)?.entry ?? {})
      })
      const response = await app.request("/v1/responses", { method: "POST" })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        serviceTierRequested: "priority",
        serviceTierRouted: "priority",
        serviceTierUpstream: "priority",
        serviceTierResponse: "default",
      })
    })
  }
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

  test("service_tier: fast maps to priority, priority/flex/ultrafast kept, others stripped", async () => {
    for (const tier of [
      "fast",
      "priority",
      "flex",
      "ultrafast",
      "default",
      "auto",
      "scale",
      "standard",
      null,
    ]) {
      const body = await capturePostedBody({
        model: "gpt-5",
        input: [{ type: "message", role: "user", content: "hi" }],
        stream: true,
        service_tier: tier,
      })
      if (tier === "fast") {
        expect(body.service_tier).toBe("priority")
      } else if (
        tier === "priority"
        || tier === "flex"
        || tier === "ultrafast"
      ) {
        expect(body.service_tier).toBe(tier)
      } else {
        expect(Object.hasOwn(body, "service_tier")).toBe(false)
      }
    }
  })

  test("prompt_cache_options is stripped (upstream rejects it; prompt_cache_key stays)", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      input: [{ type: "message", role: "user", content: "hi" }],
      stream: true,
      prompt_cache_key: "session-1",
      prompt_cache_options: { mode: "aggressive" },
      prompt_cache_retention: "24h",
    })
    expect(Object.hasOwn(body, "prompt_cache_options")).toBe(false)
    expect(Object.hasOwn(body, "prompt_cache_retention")).toBe(false)
    expect(body.prompt_cache_key).toBe("session-1")
  })

  test("prompt_cache_breakpoint is stripped at item level and inside content/output parts", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      stream: true,
      input: [
        {
          type: "message",
          role: "user",
          prompt_cache_breakpoint: true,
          content: [
            { type: "input_text", text: "a", prompt_cache_breakpoint: true },
            { type: "input_text", text: "b" },
          ],
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "output_text", text: "o", prompt_cache_breakpoint: true },
          ],
        },
      ],
    })
    const items = body.input as Array<Record<string, unknown>>
    expect(items[0].prompt_cache_breakpoint).toBeUndefined()
    expect(items[0].content).toEqual([
      { type: "input_text", text: "a" },
      { type: "input_text", text: "b" },
    ])
    expect(items[1].output).toEqual([{ type: "output_text", text: "o" }])
  })

  test("blank function_call arguments are normalized to {}", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      stream: true,
      input: [
        { type: "function_call", call_id: "c1", name: "lookup", arguments: "" },
        {
          type: "function_call",
          call_id: "c2",
          name: "lookup",
          arguments: '{"q":"x"}',
        },
      ],
    })
    const items = body.input as Array<{ arguments?: string }>
    expect(items[0].arguments).toBe("{}")
    expect(items[1].arguments).toBe('{"q":"x"}')
  })

  test("legacy builtin tool names are normalized (tools, tool_choice.type, tool_choice.tools)", async () => {
    const body = await capturePostedBody({
      model: "gpt-5",
      stream: true,
      input: [{ type: "message", role: "user", content: "hi" }],
      tools: [
        { type: "web_search_preview" },
        { type: "web_search_preview_2025_03_11" },
        { type: "function", name: "lookup" },
      ],
      tool_choice: {
        type: "web_search_preview",
        tools: [{ type: "web_search_preview" }],
      },
    })
    const tools = body.tools as Array<{ type: string }>
    expect(tools[0].type).toBe("web_search")
    expect(tools[1].type).toBe("web_search")
    expect(tools[2].type).toBe("function")
    const tc = body.tool_choice as {
      type: string
      tools: Array<{ type: string }>
    }
    expect(tc.type).toBe("web_search")
    expect(tc.tools[0].type).toBe("web_search")
  })

  test("image_generation tool is injected for paid plans and skipped for free/lite/spark", async () => {
    const paid = makeCodexSubject()
    paid.credential.context = { ...paid.credential.context, planType: "plus" }
    const paidBody = await capturePostedBody(
      {
        model: "gpt-5",
        input: [{ type: "message", role: "user", content: "hi" }],
        stream: true,
      },
      {},
      paid,
    )
    expect(paidBody.tools).toEqual([
      { type: "image_generation", output_format: "png" },
    ])

    const free = makeCodexSubject()
    free.credential.context = { ...free.credential.context, planType: "free" }
    const freeBody = await capturePostedBody(
      {
        model: "gpt-5",
        input: [{ type: "message", role: "user", content: "hi" }],
        stream: true,
      },
      {},
      free,
    )
    expect(freeBody.tools).toBeUndefined()

    // spark models skip injection even on paid plans.
    const sparkBody = await capturePostedBody(
      {
        model: "gpt-5.3-codex-spark",
        input: [{ type: "message", role: "user", content: "hi" }],
        stream: true,
      },
      {},
      paid,
    )
    expect(sparkBody.tools).toBeUndefined()

    // responses-lite requests skip injection via the forwarded header.
    const liteBody = await capturePostedBody(
      {
        model: "gpt-5",
        input: [{ type: "message", role: "user", content: "hi" }],
        stream: true,
      },
      { headers: { "x-openai-internal-codex-responses-lite": "true" } },
      paid,
    )
    expect(liteBody.tools).toBeUndefined()
  })

  test("image_generation tool is not duplicated when already present", async () => {
    const paid = makeCodexSubject()
    paid.credential.context = { ...paid.credential.context, planType: "plus" }
    const body = await capturePostedBody(
      {
        model: "gpt-5",
        input: [{ type: "message", role: "user", content: "hi" }],
        stream: true,
        tools: [{ type: "image_generation", output_format: "jpeg" }],
      },
      {},
      paid,
    )
    expect(body.tools).toEqual([
      { type: "image_generation", output_format: "jpeg" },
    ])
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
