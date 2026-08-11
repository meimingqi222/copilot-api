import { afterEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import { createCodexResponsesOnce } from "~/services/codex/create-responses-once"

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
  opts: { headers?: Record<string, string> } = {},
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
    { forwardedHeaders: opts.headers ?? {} },
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
})
