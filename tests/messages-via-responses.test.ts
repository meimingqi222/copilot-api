import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

import type {
  ChatCompletionChunk,
  Message,
} from "~/services/protocols/chat/types"

import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  addCredential,
  deleteCredential,
  updateConnection,
  updateCredential,
} from "~/lib/provider-connections"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"
import {
  getTranslationLossMetricsSnapshot,
  resetTranslationLossMetricsForTest,
} from "~/services/ir"
import { ResponsesToolReplay } from "~/services/protocols/responses-tool-replay"

const originalFetch = globalThis.fetch

async function chatAssistant(
  response: Response,
  stream: boolean,
): Promise<Message> {
  if (!stream) {
    const body = (await response.json()) as {
      choices: Array<{ message: Message }>
    }
    return body.choices[0]!.message
  }
  const message: Message = {
    role: "assistant",
    content: "",
  }
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue
    const chunk = JSON.parse(line.slice(5)) as ChatCompletionChunk
    for (const { delta } of chunk.choices ?? []) {
      if (typeof delta.content === "string")
        message.content = String(message.content ?? "") + delta.content
      if (delta.reasoning_content)
        message.reasoning_content =
          (message.reasoning_content ?? "") + delta.reasoning_content
      for (const call of delta.tool_calls ?? []) {
        message.tool_calls ??= []
        const tool = (message.tool_calls[call.index] ??= {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        })
        if (call.id) tool.id = call.id
        if (call.function?.name) tool.function.name = call.function.name
        tool.function.arguments += call.function?.arguments ?? ""
      }
    }
  }
  return message
}

test.each([
  { stream: false, terminalOnly: false },
  { stream: true, terminalOnly: false },
  { stream: true, terminalOnly: true },
  { stream: true, terminalOnly: false, terminalOmitsCiphertext: true },
  { stream: true, terminalOnly: false, terminalReasoningOnly: true },
])(
  "Chat tool rounds recover native Responses reasoning without session headers (stream=$stream terminalOnly=$terminalOnly terminalReasoningOnly=$terminalReasoningOnly)",
  async ({
    stream,
    terminalOnly,
    terminalOmitsCiphertext,
    terminalReasoningOnly,
  }) => {
    const sent: Array<Record<string, unknown>> = []
    const thoughts = [0, 1].map((round) => ({
      id: `rs_native_${round}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: `native thought ${round}` }],
      encrypted_content: `opaque-native-state-${round}`,
      status: "completed",
    }))
    const sealed = thoughts.map((thought, round) => ({
      ...thought,
      id: `rs_sealed_${round}`,
      summary: [],
      encrypted_content: `opaque-native-hidden-${round}`,
    }))
    globalThis.fetch = mock((_url: unknown, options?: RequestInit) => {
      const round = sent.length
      sent.push(JSON.parse(String(options?.body)) as Record<string, unknown>)
      const output: Array<Record<string, unknown>> =
        round < 2 ?
          [
            thoughts[round],
            sealed[round],
            {
              id: `msg_${round}`,
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: `step ${round}` }],
            },
            ...[0, 1].map((index) => ({
              id: `fc_${round}_${index}`,
              type: "function_call",
              call_id: `call_original_${round}_${index}`,
              name: "read",
              arguments: '{"path":"file","limit":2}',
              status: "completed",
            })),
          ]
        : [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }],
            },
          ]
      const body = {
        id: `resp_${round}`,
        model: "gpt-responses",
        status: "completed",
        output,
        usage: { input_tokens: 20, output_tokens: 10 },
      }
      if (!stream) return Promise.resolve(Response.json(body))
      const events =
        terminalOnly ?
          []
        : output.flatMap((item, output_index) =>
            terminalReasoningOnly && item.type === "reasoning" ?
              []
            : [
                {
                  type: "response.output_item.added",
                  output_index,
                  item:
                    item.type === "function_call" ?
                      { ...item, arguments: "" }
                    : item,
                },
                { type: "response.output_item.done", output_index, item },
              ],
          )
      return Promise.resolve(
        new Response(
          [
            ...events,
            {
              type: "response.completed",
              response:
                terminalOmitsCiphertext ?
                  {
                    ...body,
                    output: output.map((item) => {
                      if (item.type !== "reasoning") return item
                      const { encrypted_content: _encrypted, ...summary } = item
                      return summary
                    }),
                  }
                : body,
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
      )
    }) as unknown as typeof fetch
    const messages: Array<Message> = [
      { role: "user", content: "implement resume" },
    ]
    for (let round = 0; round < 3; round++) {
      const response = await server.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer native-replay-caller",
          },
          body: JSON.stringify({
            model: "gpt-responses",
            stream,
            reasoning_effort: "high",
            messages,
            tools: [
              {
                type: "function",
                function: { name: "read", parameters: { type: "object" } },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)
      const assistant = await chatAssistant(response, stream)
      if (round === 2) {
        expect(assistant.content).toBe("done")
        break
      }
      expect(assistant.reasoning_content).toBe(`native thought ${round}`)
      expect(assistant.tool_calls).toHaveLength(2)
      expect(JSON.stringify(assistant)).not.toContain("opaque-native-state")
      for (const call of assistant.tool_calls ?? []) {
        expect(call.id.length).toBeLessThanOrEqual(64)
        call.function.arguments = '{ "limit": 2, "path": "file" }'
      }
      messages.push(assistant)
      for (const call of assistant.tool_calls ?? [])
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "file contents",
        })
    }
    expect(sent[0]?.include).toContain("reasoning.encrypted_content")
    for (const round of [1, 2]) {
      const input = sent[round]?.input as Array<Record<string, unknown>>
      expect(input.filter((item) => item.type === "reasoning")).toEqual(
        thoughts
          .slice(0, round)
          .flatMap((thought, index) => [thought, sealed[index]]),
      )
      for (let previous = 0; previous < round; previous++) {
        const reasoningIndex = input.findIndex(
          (item) => item.id === thoughts[previous]?.id,
        )
        const textIndex = input.findIndex((item) => item.role === "assistant")
        if (previous === 0) expect(reasoningIndex).toBeLessThan(textIndex)
        for (const index of [0, 1]) {
          const callId = `call_original_${previous}_${index}`
          expect(
            input.find(
              (item) =>
                item.type === "function_call" && item.call_id === callId,
            ),
          ).toMatchObject({
            id: `fc_${previous}_${index}`,
            arguments: '{"path":"file","limit":2}',
          })
          expect(
            input.find(
              (item) =>
                item.type === "function_call_output" && item.call_id === callId,
            ),
          ).toBeDefined()
        }
      }
      expect(JSON.stringify(input)).not.toContain("[historical reasoning]")
    }
  },
)

test.each([
  { status: "completed", reasoning: true },
  { status: "completed", reasoning: false },
  { status: "incomplete", reasoning: true },
  { status: "failed", reasoning: true },
])(
  "early streamed tool references stay stable and publish only completed reasoning (status=$status reasoning=$reasoning)",
  async ({ status, reasoning }) => {
    const replay = new ResponsesToolReplay(`early-tool-${status}-${reasoning}`)
    const thought = {
      id: "rs_terminal",
      type: "reasoning" as const,
      summary: [],
      encrypted_content: "terminal-native-state",
    }
    const call = {
      id: "fc_early",
      type: "function_call" as const,
      call_id: "call_early",
      name: "read",
      arguments: "{}",
    }
    const index = reasoning ? 1 : 0
    const packets = [
      {
        type: "response.output_item.added",
        output_index: index,
        item: { ...call, arguments: "" },
      },
      { type: "response.output_item.done", output_index: index, item: call },
      {
        type: `response.${status}`,
        response: {
          id: "resp_early",
          model: "gpt-responses",
          status,
          output: [...(reasoning ? [thought] : []), call],
        },
      },
    ]
    async function* upstream() {
      for (const packet of packets) yield { data: JSON.stringify(packet) }
    }
    const ids: Array<string> = []
    for await (const event of replay.stream(upstream())) {
      const packet = JSON.parse(event.data!) as {
        item?: { call_id: string }
        response?: { output: Array<{ call_id?: string }> }
      }
      // Failed packets pass through unchanged and cannot publish replay state.
      if (packet.item) ids.push(packet.item.call_id)
      else if (status !== "failed")
        ids.push(packet.response!.output[index]!.call_id!)
    }
    expect(ids[0]).toMatch(/^call_rp_[a-f0-9]{32}_\d+$/)
    expect(new Set(ids).size).toBe(1)
    const clientId = ids[0]!
    const result = {
      type: "function_call_output" as const,
      call_id: clientId,
      output: "ok",
    }
    const restored = await replay.restore({
      model: "gpt-responses",
      input: [{ ...call, type: "function_call", call_id: clientId }, result],
    })
    expect(restored.input).toEqual(
      status === "completed" && reasoning ?
        [thought, call, { ...result, call_id: call.call_id }]
      : [{ ...call, call_id: clientId }, result],
    )
  },
)

test.each([
  "caller",
  "upstream",
  "credential",
  "credential-value",
  "model",
  "arguments",
  "expired",
  "missing",
  "incomplete",
  "oversized",
])(
  "Chat native replay does not reuse state after %s changes",
  async (boundary) => {
    const thought = {
      id: "rs_isolated",
      type: "reasoning",
      summary: [],
      encrypted_content:
        boundary === "oversized" ?
          "x".repeat(121 * 1024)
        : "isolated-native-state",
    }
    const sent: Array<Record<string, unknown>> = []
    globalThis.fetch = mock((_url: unknown, options?: RequestInit) => {
      sent.push(JSON.parse(String(options?.body)) as Record<string, unknown>)
      return Promise.resolve(
        Response.json({
          id: "resp_isolated",
          model: "gpt-responses",
          status: boundary === "incomplete" ? "incomplete" : "completed",
          output: [
            thought,
            ...[0, 1].map((index) => ({
              id: `fc_isolated_${index}`,
              type: "function_call",
              call_id: `call_isolated_${index}`,
              name: "read",
              arguments: "{}",
            })),
          ],
        }),
      )
    }) as unknown as typeof fetch
    async function post(messages: Array<Message>, caller: string) {
      const response = await server.fetch(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${caller}`,
          },
          body: JSON.stringify({ model: "gpt-responses", messages }),
        }),
      )
      expect(response.status).toBe(200)
      return chatAssistant(response, false)
    }
    const messages: Array<Message> = [{ role: "user", content: "work" }]
    const assistant = await post(messages, "caller-a")
    const call = assistant.tool_calls![0]!
    expect(call.id).not.toBe("call_isolated_0")
    messages.push(assistant)
    for (const tool of assistant.tool_calls!)
      messages.push({ role: "tool", tool_call_id: tool.id, content: "ok" })
    if (boundary === "upstream")
      await updateConnection("responses-conn", {
        baseUrl: "https://other.responses.test/v1",
      })
    if (boundary === "credential") {
      await addCredential("responses-conn", {
        id: "cred-other",
        value: "other",
        authMode: "bearer",
      })
      await deleteCredential("responses-conn", "cred-1")
    }
    if (boundary === "credential-value")
      await updateCredential("responses-conn", "cred-1", {
        value: "changed-credential",
      })
    if (boundary === "model")
      await updateConnection("responses-conn", {
        models: [
          {
            publicId: "gpt-responses",
            upstreamId: "other-model",
            endpoints: ["responses"],
            enabled: true,
          },
        ],
      })
    if (boundary === "arguments") call.function.arguments = '{"changed":true}'
    if (boundary === "missing")
      for (const [index, tool] of assistant.tool_calls!.entries())
        tool.id = messages[index + 2]!.tool_call_id =
          `call_rp_00000000000000000000000000000000_${index}`
    const now = Date.now()
    const clock =
      boundary === "expired" ?
        spyOn(Date, "now").mockReturnValue(now + 3_600_001)
      : undefined
    try {
      await post(messages, boundary === "caller" ? "caller-b" : "caller-a")
    } finally {
      clock?.mockRestore()
    }
    const input = sent[1]!.input as Array<Record<string, unknown>>
    expect(input.filter((item) => item.type === "reasoning")).toEqual([])
    expect(input.find((item) => item.type === "function_call")?.call_id).toBe(
      call.id,
    )
    expect(
      input.find((item) => item.type === "function_call_output")?.call_id,
    ).toBe(call.id)
    expect(JSON.stringify(input)).not.toContain("isolated-native-state")
  },
)

beforeEach(async () => {
  statsStore.clearUsageStatsForTest()
  resetAdaptiveRateLimiterForTest()
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
  resetAdaptiveRateLimiterForTest()
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
