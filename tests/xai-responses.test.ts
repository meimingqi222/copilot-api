import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"

import type { ProviderConnection } from "~/lib/provider-connections"
import type {
  CopilotStreamEventLike,
  ResponsesResponse,
} from "~/services/protocols/responses/types"

import { decodeResponsesResult } from "~/services/ir/codecs/responses/result"
import { decodeResponsesStream } from "~/services/ir/codecs/responses/stream"
import { createXaiResponsesOnce } from "~/services/xai/create-responses-once"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function connection(): ProviderConnection {
  return {
    id: crypto.randomUUID(),
    name: "xai-test",
    protocol: "xai-native",
    baseUrl: "https://api.x.ai/v1",
    enabled: true,
    priority: 0,
    createdAt: 0,
    credentials: [
      {
        id: "cred",
        value: "test-token",
        authMode: "bearer",
        enabled: true,
        status: "ready",
        createdAt: 0,
      },
    ],
  }
}

function mockStream(
  events: Array<Record<string, unknown>>,
  requests: Array<RequestInit> = [],
) {
  globalThis.fetch = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {})
      return new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
}

const reasoning = {
  id: "rs_1",
  type: "reasoning",
  content: [{ type: "reasoning_text", text: "Inspect tool output." }],
}
function completed(output: Array<Record<string, unknown>>) {
  return {
    type: "response.completed",
    response: { id: "resp_1", model: "grok-4.7", status: "completed", output },
  }
}

test.each([true, false])(
  "Grok reasoning content survives Responses translation (stream=%s)",
  async (stream) => {
    mockStream([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...reasoning, content: [] },
      },
      {
        type: "response.reasoning_text.delta",
        output_index: 0,
        item_id: "rs_1",
        content_index: 0,
        delta: "Inspect tool output.",
      },
      {
        type: "response.reasoning_text.done",
        output_index: 0,
        item_id: "rs_1",
        content_index: 0,
        text: "Inspect tool output.",
      },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      completed([reasoning]),
    ])
    const conn = connection()
    const result = await createXaiResponsesOnce(
      { connection: conn, credential: conn.credentials[0]! },
      { model: "grok-4.7", input: "hello", stream },
    )
    if (stream) {
      const parts = []
      const events = []
      for await (const event of result as AsyncIterable<CopilotStreamEventLike>)
        events.push(event)
      for await (const event of decodeResponsesStream(
        (async function* () {
          yield* events
        })(),
        "grok-4.7",
      )) {
        if (event.type === "part_delta" && event.delta.type === "thinking")
          parts.push(event.delta.text)
      }
      expect(parts.join("")).toBe("Inspect tool output.")
      const textDone = events.find(
        (event) => event.event === "response.reasoning_summary_text.done",
      )
      expect(JSON.parse(textDone?.data ?? "null")).toMatchObject({
        summary_index: 0,
        text: "Inspect tool output.",
      })
    } else {
      expect(
        decodeResponsesResult(result as ResponsesResponse).parts,
      ).toContainEqual(
        expect.objectContaining({
          type: "thinking",
          text: "Inspect tool output.",
        }),
      )
    }
  },
)

test("xAI inference sends connection headers with case-insensitive overrides", async () => {
  const requests: Array<RequestInit> = []
  mockStream([completed([])], requests)
  const conn = connection()
  conn.headers = { "user-agent": "custom-client", "X-Trace": "trace-123" }
  await createXaiResponsesOnce(
    { connection: conn, credential: conn.credentials[0]! },
    { model: "grok-4.7", input: "hello" },
  )
  const headers = new Headers(requests[0]?.headers)
  expect(headers.get("user-agent")).toBe("custom-client")
  expect(headers.get("x-trace")).toBe("trace-123")
  expect(headers.get("authorization")).toBe("Bearer test-token")
})

test.each([true, false])(
  "replay is isolated by caller, connection and credential (stream=%s)",
  async (stream) => {
    const requests: Array<RequestInit> = []
    const encrypted = Buffer.from(Array.from({ length: 128 }, (_, i) => i))
      .toString("base64")
      .replace(/=+$/, "")
    mockStream(
      [
        completed([
          { type: "reasoning", encrypted_content: encrypted, summary: [] },
        ]),
      ],
      requests,
    )
    const conn = connection()
    const payload = {
      model: "grok-4.7",
      input: [{ role: "user" as const, content: "hello" }],
      prompt_cache_key: crypto.randomUUID(),
      stream,
    }
    const run = async (subject: ProviderConnection, caller: string) => {
      const app = new Hono()
      app.get("/", async (c) => {
        c.set("userId" as never, caller as never)
        const result = await createXaiResponsesOnce(
          { connection: subject, credential: subject.credentials[0]! },
          payload,
          undefined,
          { c },
        )
        if (stream)
          for await (const _event of result as AsyncIterable<CopilotStreamEventLike>) {
            /* consume the complete turn */
          }
        return c.text("ok")
      })
      expect((await app.request("/")).status).toBe(200)
    }
    await run(conn, "user:a")
    await run(conn, "user:a")
    await run(conn, "user:b")
    await run({ ...conn, id: crypto.randomUUID() }, "user:a")
    await run(
      {
        ...conn,
        credentials: [{ ...conn.credentials[0]!, id: "other-credential" }],
      },
      "user:a",
    )
    const replay = requests.map((request) =>
      (
        JSON.parse(String(request.body)) as { input: Array<{ type?: string }> }
      ).input.some((item) => item.type === "reasoning"),
    )
    expect(replay).toEqual([false, true, false, false, false])
  },
)

test("HTTP transcript fallback never recovers another caller's conversation", async () => {
  const conn = connection()
  const executionSessionId = crypto.randomUUID()
  const requests: Array<RequestInit> = []
  mockStream(
    [
      completed([
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Private answer" }],
        },
      ]),
    ],
    requests,
  )
  const subject = { connection: conn, credential: conn.credentials[0]! }
  const ctx = {
    executionSessionId,
    downstreamWebsocket: true,
    forceUpstreamHttp: true,
  }
  await createXaiResponsesOnce(
    subject,
    {
      model: "grok-4.7",
      input: [{ role: "user", content: "Private question" }],
    },
    undefined,
    { ...ctx, transcriptScopeId: "user:a" },
  )
  const next = {
    model: "grok-4.7",
    previous_response_id: "resp_1",
    input: [{ role: "user" as const, content: "Continue" }],
  }
  await expect(
    createXaiResponsesOnce(subject, next, undefined, {
      ...ctx,
      transcriptScopeId: "user:b",
    }),
  ).rejects.toThrow("previous_response_not_found")
  await createXaiResponsesOnce(subject, next, undefined, {
    ...ctx,
    transcriptScopeId: "user:a",
  })
  expect(requests).toHaveLength(2)
  expect(
    (JSON.parse(String(requests[1]?.body)) as { input: unknown }).input,
  ).toEqual([
    { role: "user", content: "Private question" },
    expect.objectContaining({
      type: "message",
      content: [{ type: "output_text", text: "Private answer" }],
    }),
    { role: "user", content: "Continue" },
  ])
})

test("reasoning normalization preserves existing summaries, seals and namespace tools", async () => {
  const seal = "opaque-upstream-seal"
  mockStream([
    completed([
      {
        ...reasoning,
        summary: [{ type: "summary_text", text: "Public summary" }],
        encrypted_content: seal,
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "repo__read",
        arguments: '{"path":"a.ts"}',
      },
    ]),
  ])
  const conn = connection()
  const result = (await createXaiResponsesOnce(
    { connection: conn, credential: conn.credentials[0]! },
    {
      model: "grok-4.7",
      input: "hello",
      tools: [
        {
          type: "namespace",
          name: "repo",
          tools: [
            {
              type: "function",
              name: "read",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
              },
            },
          ],
        },
      ],
    },
  )) as ResponsesResponse
  expect(result.output as unknown).toEqual([
    {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Public summary" }],
      encrypted_content: seal,
    },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "read",
      namespace: "repo",
      arguments: '{"path":"a.ts"}',
    },
  ])
})
