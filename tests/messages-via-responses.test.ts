import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  updateConnection,
} from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import {
  getTranslationLossMetricsSnapshot,
  resetTranslationLossMetricsForTest,
} from "~/services/ir"

const originalFetch = globalThis.fetch

beforeEach(async () => {
  statsStore.clearUsageStatsForTest()
  resetTranslationLossMetricsForTest()
  resetProtectedRouteGuardForTest()
  __resetProviderConnectionsForTest()
  await createConnection({
    id: "responses-conn",
    name: "responses",
    protocol: "openai-responses-compatible",
    baseUrl: "https://api.responses.test/v1",
    credentials: [{ id: "cred-1", value: "sk-test", authMode: "bearer" }],
    models: [
      {
        publicId: "gpt-responses",
        upstreamId: "gpt-responses",
        endpoints: ["responses"],
        enabled: true,
      },
    ],
  })
})

afterEach(() => {
  statsStore.clearUsageStatsForTest()
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
})

test("POST /v1/messages sends a named schema to a responses-only connection", async () => {
  const fetchMock = mock((url: string) => ({
    ok: true,
    json: () => ({
      id: "resp_1",
      object: "response",
      model: "gpt-responses",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from responses" }],
        },
      ],
      output_text: "Hello from responses",
      usage: { input_tokens: 3, output_tokens: 5 },
    }),
    text: () => Promise.resolve(""),
    status: 200,
    url,
    headers: {},
  }))
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await server.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-responses",
        max_tokens: 256,
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
          },
        },
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  const [url, options] = fetchMock.mock.calls[0] as unknown as [
    string,
    { body?: string },
  ]
  expect(url).toContain("/responses")
  expect(JSON.parse(options.body ?? "{}")).toMatchObject({
    model: "gpt-responses",
    max_output_tokens: 256,
    text: {
      format: {
        type: "json_schema",
        name: "response",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    },
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  })

  const body = (await response.json()) as {
    type: string
    content: Array<{ type: string; text?: string }>
  }
  expect(body.type).toBe("message")
  expect(body.content).toEqual([{ type: "text", text: "Hello from responses" }])
})

test.each(
  ["chat", "messages"].flatMap((wire) =>
    [false, true].flatMap((stream) =>
      (stream ? [false, true] : [false]).flatMap((terminalOnly) =>
        [false, true].map((deepseek) => ({
          wire,
          stream,
          terminalOnly,
          deepseek,
        })),
      ),
    ),
  ),
)(
  "$wire → Responses keeps reasoning out of prose (stream=$stream terminalOnly=$terminalOnly deepseek=$deepseek)",
  async ({ wire, stream, terminalOnly, deepseek }) => {
    if (deepseek)
      await updateConnection("responses-conn", {
        baseUrl: "https://api.deepseek.com/v1",
        models: [
          {
            publicId: "gpt-responses",
            upstreamId: "deepseek-flash",
            endpoints: ["responses"],
            enabled: true,
          },
        ],
      })
    const output = [
      {
        type: "reasoning",
        id: "rs_new",
        summary:
          deepseek ? [] : [{ type: "summary_text", text: "new thought" }],
        ...(deepseek && {
          content: [{ type: "reasoning_text", text: "new thought" }],
        }),
      },
      {
        type: "message",
        id: "msg_new",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "new answer", annotations: [] }],
      },
    ]
    const completed = {
      id: "resp_new",
      object: "response",
      model: "gpt-responses",
      status: "completed",
      output,
      usage: { input_tokens: 20, output_tokens: 5 },
    }
    let sent: Record<string, unknown> | undefined
    globalThis.fetch = mock((_url: unknown, options?: RequestInit) => {
      sent = JSON.parse(String(options?.body)) as Record<string, unknown>
      if (!stream) return Promise.resolve(Response.json(completed))
      const events: Array<Record<string, unknown>> =
        terminalOnly ?
          []
        : [
            {
              type: "response.created",
              response: { ...completed, status: "in_progress", output: [] },
            },
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...output[0], summary: [], content: [] },
            },
            {
              type:
                deepseek ?
                  "response.reasoning_text.delta"
                : "response.reasoning_summary_text.delta",
              output_index: 0,
              summary_index: 0,
              delta: "new thought",
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: output[0],
            },
            {
              type: "response.output_item.added",
              output_index: 1,
              item: { ...output[1], content: [] },
            },
            {
              type: "response.content_part.added",
              output_index: 1,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            },
            {
              type: "response.output_text.delta",
              output_index: 1,
              content_index: 0,
              delta: "new answer",
            },
            {
              type: "response.output_item.done",
              output_index: 1,
              item: output[1],
            },
          ]
      events.push({ type: "response.completed", response: completed })
      return Promise.resolve(
        new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    }) as unknown as typeof fetch
    // Literal marker text in real published prose must not be regex-cleaned.
    const prose = "Published [historical reasoning] literally."
    const tools =
      wire === "chat" ?
        [
          {
            type: "function",
            function: { name: "read", parameters: { type: "object" } },
          },
        ]
      : [{ name: "read", input_schema: { type: "object" } }]
    const messages =
      wire === "chat" ?
        [
          { role: "user", content: "inspect" },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "private old plan" },
              { type: "text", text: prose },
            ],
            reasoning_content: "private old plan",
            tool_calls: [
              {
                id: "call_old",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_old", content: "tool data" },
          { role: "user", content: "continue" },
        ]
      : [
          { role: "user", content: "inspect" },
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "private old plan",
                signature: "old-signature",
              },
              { type: "text", text: prose },
              { type: "tool_use", id: "call_old", name: "read", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_old",
                content: "tool data",
              },
              { type: "text", text: "continue" },
            ],
          },
        ]
    const response = await server.request(
      wire === "chat" ? "/v1/chat/completions" : "/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-responses",
          max_tokens: 256,
          messages,
          tools,
          stream,
        }),
      },
    )
    expect(response.status).toBe(200)
    expect(sent?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "inspect" }] },
      ...(deepseek ?
        [
          {
            type: "reasoning",
            summary: [],
            content: [{ type: "reasoning_text", text: "private old plan" }],
          },
        ]
      : []),
      { role: "assistant", content: [{ type: "output_text", text: prose }] },
      {
        type: "function_call",
        call_id: "call_old",
        name: "read",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_old",
        output: "tool data",
      },
      { role: "user", content: [{ type: "input_text", text: "continue" }] },
    ])
    expect(sent?.tools).toEqual([
      { type: "function", name: "read", parameters: { type: "object" } },
    ])
    if (!deepseek)
      expect(JSON.stringify(sent)).not.toContain("private old plan")
    expect(JSON.stringify(sent)).not.toContain("old-signature")
    const dropped = {
      feature: wire === "chat" ? "unsigned_thinking" : "signed_thinking",
      action: "drop",
      reason: "foreign_reasoning_dropped",
      target: "responses",
      count: 1,
    } as const
    if (deepseek)
      expect(getTranslationLossMetricsSnapshot()).not.toContainEqual(dropped)
    else expect(getTranslationLossMetricsSnapshot()).toContainEqual(dropped)
    if (!stream) {
      const result = (await response.json()) as {
        choices?: Array<{
          message: { content: string; reasoning_content: string }
        }>
        content?: Array<{ type: string; text?: string; thinking?: string }>
      }
      if (wire === "chat")
        expect(result.choices?.[0].message).toMatchObject({
          content: "new answer",
          reasoning_content: "new thought",
        })
      else
        expect(result.content).toEqual([
          { type: "thinking", thinking: "new thought" },
          { type: "text", text: "new answer" },
        ])
    } else {
      let text = "",
        thought = ""
      const data = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
      for (const line of data) {
        const event = JSON.parse(line.slice(5)) as {
          choices?: Array<{
            delta: { content?: string; reasoning_content?: string }
          }>
          delta?: { type: string; text?: string; thinking?: string }
        }
        if (wire === "chat") {
          text += event.choices?.[0]?.delta.content ?? ""
          thought += event.choices?.[0]?.delta.reasoning_content ?? ""
        } else {
          if (event.delta?.type === "text_delta") text += event.delta.text ?? ""
          if (event.delta?.type === "thinking_delta")
            thought += event.delta.thinking ?? ""
        }
      }
      expect(text).toBe("new answer")
      expect(thought).toBe("new thought")
    }
  },
)
