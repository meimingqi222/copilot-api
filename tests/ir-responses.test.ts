import { describe, expect, spyOn, test } from "bun:test"

import type { ChatCompletionChunk } from "~/services/protocols/chat/types"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"
import { chunkFromText, doneChunk } from "~/services/windsurf/chunk-builders"
import type { WindsurfStreamEvent } from "~/services/windsurf/collect-response"
import type { RequestIR, StreamEvent } from "~/services/ir/types"

import { planTranslation } from "~/services/ir"
import { encodeChatRequest } from "~/services/ir/codecs/messages-chat/request"
import { encodeChatStream } from "~/services/ir/codecs/messages-chat/stream"
import {
  decodeResponsesRequest,
  encodeResponsesRequest,
} from "~/services/ir/codecs/responses/request"
import {
  decodeResponsesResult,
  encodeResponsesResult,
} from "~/services/ir/codecs/responses/result"
import {
  decodeResponsesStream,
  encodeResponsesStream,
} from "~/services/ir/codecs/responses/stream"
import { createResponsesViaChat } from "~/services/protocols/responses-via-chat"
import { CustomToolInputDecoder } from "~/services/ir/codecs/responses/custom-tool-input"
import { customToolInputPrefix } from "~/services/ir/codecs/responses/custom-tool"
import { createTranslatedCall } from "~/services/protocols/wire-pairs"
import { encodeMessagesResponse } from "~/services/ir/codecs/messages-chat/response"
import { encodeMessagesStream } from "~/services/ir/codecs/messages-chat/stream"

function payload(
  input: unknown,
  extra: Record<string, unknown> = {},
): ResponsesPayload {
  return { model: "test-model", input, ...extra } as ResponsesPayload
}

describe("Responses IR request codec", () => {
  test("hosted tool dropping cannot weaken a required or named tool contract", () => {
    for (const choice of ["required", { type: "function", name: "hosted" }])
      expect(() =>
        decodeResponsesRequest(
          payload("hello", {
            tools: [{ type: "mcp", name: "hosted" }],
            tool_choice: choice,
          }),
        ),
      ).toThrow("tool")
  })
  test("lifts developer-role Lite tools and unwraps functions namespace consistently", () => {
    const request = decodeResponsesRequest(
      payload(
        [
          {
            type: "additional_tools",
            role: "developer",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [{ type: "custom", name: "apply_patch" }],
              },
            ],
          },
          { role: "user", content: "edit" },
          {
            type: "custom_tool_call",
            call_id: "patch",
            namespace: "functions",
            name: "apply_patch",
            input: "patch text",
          },
          { type: "custom_tool_call_output", call_id: "patch", output: "ok" },
        ],
        {
          tool_choice: {
            type: "custom",
            namespace: "functions",
            name: "apply_patch",
          },
        },
      ),
    )
    expect(request.tools?.map((tool) => tool.name)).toEqual(["apply_patch"])
    expect(request.instructions).toEqual([])
    expect(request.toolChoice).toEqual({ type: "tool", name: "apply_patch" })
    expect(request.turns[1]?.parts[0]).toMatchObject({
      type: "tool_call",
      name: "apply_patch",
    })
    expect(encodeChatRequest(request).tool_choice).toEqual({
      type: "function",
      function: { name: "apply_patch" },
    })
  })

  test("client tool search restores discovered tools, history and response kinds", async () => {
    const request = decodeResponsesRequest(
      payload(
        [
          {
            type: "tool_search_call",
            call_id: "search",
            arguments: { query: "repo" },
          },
          {
            type: "tool_search_output",
            call_id: "search",
            tools: [
              {
                type: "namespace",
                name: "repo",
                tools: [
                  {
                    type: "function",
                    name: "read",
                    parameters: { type: "object" },
                  },
                ],
              },
            ],
          },
          { role: "user", content: "read now" },
        ],
        {
          tools: [
            {
              type: "tool_search",
              execution: "client",
              parameters: {
                type: "object",
                properties: { query: { type: "string" } },
              },
            },
          ],
          tool_choice: { type: "tool_search" },
        },
      ),
    )
    expect(request.tools?.map((tool) => tool.name)).toEqual([
      "tool_search",
      "repo__read",
    ])
    expect(request.turns[1]?.parts[0]).toMatchObject({
      type: "tool_result",
      callId: "search",
      content: [
        {
          type: "text",
          text: "These tools are now available to call: repo__read",
        },
      ],
    })
    const part = {
      type: "tool_call" as const,
      id: "search2",
      name: "tool_search",
      arguments: '{"query":"next"}',
    }
    const result = encodeResponsesResult(
      {
        id: "search-response",
        model: "test-model",
        source: { wire: "chat" },
        parts: [part],
      },
      request,
    )
    expect(result.output?.[0]).toMatchObject({
      type: "tool_search_call",
      execution: "client",
      call_id: "search2",
      arguments: { query: "next" },
    })
    const wire = []
    for await (const event of encodeResponsesStream(
      (async function* (): AsyncIterable<StreamEvent> {
        yield {
          type: "message_start",
          id: "r",
          model: "test-model",
          source: { wire: "chat" },
        }
        yield {
          type: "part_start",
          partId: "s",
          index: 0,
          part: { ...part, arguments: "" },
        }
        yield {
          type: "part_delta",
          partId: "s",
          index: 0,
          delta: { type: "tool_arguments", text: part.arguments },
        }
        yield { type: "part_end", partId: "s", index: 0 }
        yield {
          type: "message_end",
          stop: { reason: "tool_calls" },
          status: "completed",
        }
      })(),
      request,
    ))
      wire.push(JSON.parse(String(event.data)) as Record<string, unknown>)
    expect(wire.map((e) => e.type)).not.toContain(
      "response.function_call_arguments.delta",
    )
    expect(wire).toContainEqual(
      expect.objectContaining({
        type: "response.output_item.done",
        item: expect.objectContaining({
          type: "tool_search_call",
          id: "s",
          arguments: { query: "next" },
        }),
      }),
    )
  })

  test("Codex compatibility keeps effort, agent messages and late instructions in order", () => {
    const request = decodeResponsesRequest(
      payload(
        [
          { role: "developer", content: "initial" },
          { role: "user", content: "first" },
          { role: "developer", content: "changed world" },
          { type: "configuration_update", reasoning: { effort: "xhigh" } },
          {
            type: "reasoning",
            summary: [],
            content: [{ type: "reasoning_text", text: "thought" }],
          },
          { role: "assistant", content: "answer" },
          { type: "agent_message", content: "task" },
        ],
        { reasoning: { effort: "low", summary: "auto" } },
      ),
    )
    expect(request.generation?.reasoning).toMatchObject({
      effort: "xhigh",
      summary: "auto",
    })
    expect(request.instructions).toHaveLength(1)
    expect(request.turns.map((turn) => turn.role)).toEqual([
      "user",
      "user",
      "assistant",
      "user",
    ])
    expect(request.turns[1]?.parts[0]).toEqual({
      type: "text",
      text: "<system-reminder>\nchanged world\n</system-reminder>",
    })
    expect(request.turns[2]?.parts[0]).toMatchObject({
      type: "thinking",
      text: "thought",
    })
  })

  test("decode losses report dropped Codex history and hosted tools without their contents", () => {
    const request = decodeResponsesRequest(
      payload(
        [
          { type: "compaction", encrypted_content: "private-ciphertext" },
          { type: "item_reference", id: "private-id" },
          {
            role: "user",
            content: [
              { type: "input_text", text: "hi" },
              { type: "future_optional", data: "private-data" },
            ],
          },
        ],
        {
          tools: [{ type: "file_search", vector_store_ids: ["private-store"] }],
        },
      ),
    )
    const plan = planTranslation(request, { wire: "chat" })
    expect(plan.accepted).toBe(true)
    expect(
      plan.losses.records
        .filter((r) => r.stage === "decode")
        .map((r) => r.feature),
    ).toEqual([
      "compaction",
      "item_reference",
      "future_optional",
      "file_search_tool",
    ])
    expect(JSON.stringify(plan.losses)).not.toContain("private-")
    expect(() =>
      decodeResponsesRequest(payload([{ type: "compaction_trigger" }])),
    ).toThrow("compaction_trigger")
    expect(() =>
      decodeResponsesRequest(payload([{ type: "function_call" }])),
    ).toThrow("Malformed")
  })
  test("encodes boolean search intent and respects explicit opt-out", () => {
    const request = decodeResponsesRequest(payload("hello"))
    request.generation = { webSearch: true }
    expect(encodeResponsesRequest(request).tools).toEqual([
      { type: "web_search" },
    ])
    request.generation = {
      webSearch: false,
      webSearchOptions: { allowedDomains: ["example.com"] },
    }
    expect(encodeResponsesRequest(request).tools).toBeUndefined()
  })

  test("retains namespace mapping and rejects unknown allowed tool names", () => {
    const request = decodeResponsesRequest(
      payload("hello", {
        tools: [
          {
            type: "namespace",
            name: "repo",
            tools: [{ type: "function", name: "search", parameters: {} }],
          },
        ],
        tool_choice: {
          type: "allowed_tools",
          mode: "auto",
          tools: [{ type: "function", namespace: "repo", name: "missing" }],
        },
      }),
    )
    expect(request.tools?.[0]).toMatchObject({
      name: "repo__search",
      namespace: "repo",
      originalName: "search",
    })
    expect(request.toolChoice).toEqual({
      type: "allowed",
      mode: "auto",
      names: ["repo__missing"],
    })
    expect(planTranslation(request, { wire: "chat" }).accepted).toBe(false)
  })

  test("flattens long namespace tool names within the Chat limit", () => {
    const request = decodeResponsesRequest(
      payload("hello", {
        tools: [
          {
            type: "namespace",
            name: "very_long_namespace_name_for_repository_tools",
            tools: [
              {
                type: "function",
                name: "very_long_search_tool_name_for_all_projects",
                parameters: {},
              },
            ],
          },
        ],
      }),
    )
    expect(request.tools?.[0]?.name.length).toBeLessThanOrEqual(64)
    expect(request.tools?.[0]?.originalName).toBe(
      "very_long_search_tool_name_for_all_projects",
    )
  })

  test("allowed_tools filters Chat tools before required mode is applied", () => {
    const request = decodeResponsesRequest(
      payload("hello", {
        tools: [
          { type: "function", name: "one", parameters: {} },
          { type: "function", name: "two", parameters: {} },
        ],
        tool_choice: {
          type: "allowed_tools",
          mode: "required",
          tools: [{ type: "function", name: "two" }],
        },
      }),
    )
    const plan = planTranslation(request, { wire: "chat" })
    expect(plan.accepted).toBe(true)
    const chat = encodeChatRequest(request)
    expect(chat.tools?.map((tool) => tool.function.name)).toEqual(["two"])
    expect(chat.tool_choice).toBe("required")
  })

  test("reasoning does not cross a user or tool-result boundary", () => {
    const request = decodeResponsesRequest(
      payload([
        { type: "reasoning", summary: [{ type: "summary_text", text: "old" }] },
        { role: "user", content: "next" },
        {
          type: "function_call",
          call_id: "c1",
          name: "lookup",
          arguments: "{}",
        },
      ]),
    )
    expect(request.turns[1]?.parts).toEqual([
      { type: "tool_call", id: "c1", name: "lookup", arguments: "{}" },
    ])
  })

  test("encodes image tool results and namespace calls as structured Responses items", () => {
    const request: RequestIR = {
      model: "test-model",
      source: { wire: "responses" },
      instructions: [],
      turns: [
        {
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              id: "c1",
              name: "repo__search",
              originalName: "search",
              namespace: "repo",
              arguments: "{}",
            },
          ],
        },
        {
          role: "tool",
          parts: [
            {
              type: "tool_result",
              callId: "c1",
              content: [
                {
                  type: "image",
                  source: { type: "url", url: "https://example.com/image.png" },
                },
              ],
            },
          ],
        },
      ],
    }
    const encoded = encodeResponsesRequest(request) as unknown as {
      input: Array<Record<string, unknown>>
    }
    expect(encoded.input[0]).toMatchObject({
      type: "function_call",
      call_id: "c1",
      name: "search",
      namespace: "repo",
    })
    expect(encoded.input[1]).toMatchObject({
      type: "function_call_output",
      call_id: "c1",
      output: [
        { type: "input_image", image_url: "https://example.com/image.png" },
      ],
    })
  })

  test("rejects non-portable file URLs before calling a Chat upstream", async () => {
    let called = false
    await expect(
      createResponsesViaChat({
        target: {
          upstreamModelId: "test-model",
          protocol: "openai-chat-compatible",
        },
        connection: { id: "conn" },
        credential: { id: "cred" },
        payload: payload([
          {
            role: "user",
            content: [
              { type: "input_file", file_url: "https://example.com/file.pdf" },
            ],
          },
        ]),
        executor: async () => {
          called = true
          throw new Error("must not call upstream")
        },
      } as unknown as Parameters<typeof createResponsesViaChat>[0]),
    ).rejects.toThrow("target cannot receive file content")
    expect(called).toBe(false)
  })
})

describe("Responses IR result and stream codec", () => {
  test.each([false, true])(
    "Messages upstream restores custom and search calls (stream=%s)",
    async (stream) => {
      const upstream = {
        id: "m",
        model: "test-model",
        source: { wire: "messages" as const },
        parts: [
          {
            type: "tool_call" as const,
            id: "patch",
            name: "apply_patch",
            arguments: '{"input":"patch text"}',
          },
          {
            type: "tool_call" as const,
            id: "search",
            name: "tool_search",
            arguments: '{"query":"repo"}',
          },
        ],
        stop: { reason: "tool_calls" as const },
      }
      let sent: unknown
      const result = await createTranslatedCall({
        source: "responses",
        target: "messages",
        connection: { id: "messages", protocol: "anthropic-compatible" },
        credential: { id: "cred" },
        routeTarget: {
          protocol: "anthropic-compatible",
          upstreamModelId: "test-model",
        },
        targetPayload: payload("hello", {
          stream,
          tools: [
            { type: "custom", name: "apply_patch" },
            {
              type: "tool_search",
              execution: "client",
              parameters: { type: "object" },
            },
          ],
        }),
        executor: async ({ payload: value }: { payload: unknown }) => {
          sent = value
          if (!stream)
            return {
              credentialId: "cred",
              response: encodeMessagesResponse(upstream),
            }
          return {
            credentialId: "cred",
            response: (async function* () {
              const events = (async function* (): AsyncIterable<StreamEvent> {
                yield {
                  type: "message_start",
                  id: "m",
                  model: "test-model",
                  source: { wire: "messages" },
                }
                for (const [index, part] of upstream.parts.entries()) {
                  yield {
                    type: "part_start",
                    partId: String(index),
                    index,
                    part: { ...part, arguments: "" },
                  }
                  yield {
                    type: "part_delta",
                    partId: String(index),
                    index,
                    delta: { type: "tool_arguments", text: part.arguments },
                  }
                  yield { type: "part_end", partId: String(index), index }
                }
                yield {
                  type: "message_end",
                  stop: upstream.stop,
                  status: "completed",
                }
              })()
              for await (const event of encodeMessagesStream(events, 0))
                yield { data: JSON.stringify(event) }
            })(),
          }
        },
      } as unknown as Parameters<typeof createTranslatedCall>[0])
      expect(sent).toMatchObject({
        tools: [
          expect.objectContaining({ name: "apply_patch" }),
          expect.objectContaining({ name: "tool_search" }),
        ],
      })
      let response = result.response as ResponsesResponse
      if (stream)
        for await (const frame of result.response as AsyncIterable<{
          data: string
        }>) {
          const value = JSON.parse(frame.data) as {
            type: string
            response?: ResponsesResponse
          }
          if (value.type === "response.completed" && value.response)
            response = value.response
        }
      expect(response.output).toEqual([
        expect.objectContaining({
          type: "custom_tool_call",
          call_id: "patch",
          input: "patch text",
        }),
        expect.objectContaining({
          type: "tool_search_call",
          call_id: "search",
          arguments: { query: "repo" },
        }),
      ])
    },
  )
  test("custom input prefixes decode fragmented escapes without exposing JSON wrappers", () => {
    for (const [args, input] of [
      ['{"input":"a\\', "a"],
      ['{"input":"a\\n\\uD83D', "a\n"],
      ['{"input":"a\\n\\uD83D\\uDE00\\\"b"}', 'a\n😀"b'],
      ['{"other":1', undefined],
    ] as const)
      expect(customToolInputPrefix(args)).toBe(input)
  })
  test("incremental custom input preserves every escape and surrogate split", () => {
    const args =
      " \n"
      + String.raw`{ "input" : "a\\b\n\t\r\b\f\/\"\u0000\uD83D\uDE00`
      + "😀"
      + 'z" }'
    const input = (JSON.parse(args) as { input: string }).input
    for (let split = 0; split <= args.length; split++) {
      const decoder = new CustomToolInputDecoder()
      const first = decoder.push(args.slice(0, split)) ?? ""
      const last = first.charCodeAt(first.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
      const second = decoder.push(args.slice(split)) ?? ""
      expect(first + second).toBe(input)
    }
    const decoder = new CustomToolInputDecoder()
    let streamed = ""
    // UTF-16 code units deliberately split even a literal surrogate pair.
    for (let i = 0; i < args.length; i++)
      streamed += decoder.push(args[i]) ?? ""
    expect(streamed).toBe(input)
  })

  test("incremental custom input withholds incomplete and invalid strings", () => {
    const decoder = new CustomToolInputDecoder()
    expect(decoder.push('{"input":"a\\')).toBe("a")
    expect(decoder.push("uD83")).toBe("")
    expect(decoder.push("D\\uDE00")).toBe("😀")
    expect(decoder.push("\\q")).toBeUndefined()
    expect(decoder.push('ignored"}')).toBeUndefined()
    expect(new CustomToolInputDecoder().push('{"other":"x"}')).toBeUndefined()
    expect(
      new CustomToolInputDecoder().push('{"input":"bad\ntext'),
    ).toBeUndefined()
  })

  const refusalResponse = {
    id: "refused",
    model: "test-model",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "Cannot comply" }],
      },
    ],
  } as unknown as ResponsesResponse

  test("preserves refusal text in results and replayed history", () => {
    expect(decodeResponsesResult(refusalResponse)).toMatchObject({
      parts: [{ type: "text", text: "Cannot comply" }],
      stop: { reason: "refusal" },
    })
    expect(
      decodeResponsesRequest(payload(refusalResponse.output)).turns[0]?.parts,
    ).toEqual([{ type: "text", text: "Cannot comply" }])
  })

  test.each(["", "Cannot ", "Cannot comply"])(
    "preserves refusal text and stop without duplicating snapshots after prefix %j",
    async (prefix) => {
      async function* upstream() {
        for (const frame of [
          { type: "response.refusal.delta", output_index: 0, delta: prefix },
          {
            type: "response.refusal.done",
            output_index: 0,
            refusal: "Cannot comply",
          },
          {
            type: "response.refusal.done",
            output_index: 0,
            refusal: "Cannot comply",
          },
          { type: "response.completed", response: refusalResponse },
        ])
          yield { data: JSON.stringify(frame) }
      }
      const events: Array<StreamEvent> = []
      for await (const event of decodeResponsesStream(upstream(), "test-model"))
        events.push(event)
      expect(
        events
          .flatMap((event) =>
            event.type === "part_delta" ? [event.delta.text] : [],
          )
          .join(""),
      ).toBe("Cannot comply")
      expect(events.at(-1)).toMatchObject({
        type: "message_end",
        stop: { reason: "refusal" },
      })
      expect(
        events
          .filter((event) => event.type === "part_end")
          .map((event) => event.partId),
      ).toEqual(
        events
          .filter((event) => event.type === "part_start")
          .map((event) => event.partId),
      )
    },
  )

  test("keeps reasoning order and reported usage without inventing ciphertext", () => {
    const response: ResponsesResponse = {
      id: "r1",
      model: "test-model",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs1",
          summary: [{ type: "summary_text", text: "thought" }],
        },
        {
          type: "message",
          id: "m1",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
        {
          type: "function_call",
          call_id: "c1",
          name: "lookup",
          arguments: "{}",
        },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    }
    const ir = decodeResponsesResult(response)
    expect(ir.parts.map((part) => part.type)).toEqual([
      "thinking",
      "text",
      "tool_call",
    ])
    expect(ir.usage).toMatchObject({
      source: "reported",
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      reasoningTokens: 2,
    })
    const encoded = encodeResponsesResult(ir)
    expect(encoded.output?.[0]).toMatchObject({
      type: "reasoning",
      summary: [{ text: "thought" }],
    })
    expect(encoded.output?.[0]).not.toHaveProperty("encrypted_content")
  })

  test("restores namespace on a flattened Chat tool call", () => {
    const request = decodeResponsesRequest(
      payload("hello", {
        tools: [
          {
            type: "namespace",
            name: "repo",
            tools: [{ type: "function", name: "search", parameters: {} }],
          },
        ],
      }),
    )
    const result = {
      id: "r-ns",
      model: "test-model",
      source: { wire: "chat" as const },
      parts: [
        {
          type: "tool_call" as const,
          id: "c1",
          name: "repo__search",
          arguments: "{}",
        },
      ],
    }
    expect(encodeResponsesResult(result, request).output?.[0]).toMatchObject({
      type: "function_call",
      name: "search",
      namespace: "repo",
      call_id: "c1",
    })
  })

  // Codex's apply_patch is a custom tool. A Codex request that fails over to a
  // Chat-only account (Windsurf serving the same GPT model) used to be refused
  // with "Unsupported Responses input item: custom_tool_call".
  const codexCustomTool = {
    type: "custom",
    name: "apply_patch",
    description: "Edit files.",
    format: {
      type: "grammar",
      syntax: "lark",
      definition: "start: begin_patch",
    },
  }

  test("offers a custom tool and its history to Chat as a function", () => {
    const request = decodeResponsesRequest(
      payload(
        [
          { role: "user", content: "fix it" },
          {
            type: "custom_tool_call",
            call_id: "call_1",
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch",
          },
          { type: "custom_tool_call_output", call_id: "call_1", output: "ok" },
        ],
        {
          tools: [codexCustomTool],
          tool_choice: { type: "custom", name: "apply_patch" },
        },
      ),
    )
    const chat = encodeChatRequest(request)
    const tool = chat.tools?.[0]
    expect(tool?.function.name).toBe("apply_patch")
    expect(tool?.function.parameters).toMatchObject({
      required: ["input"],
      properties: { input: { type: "string" } },
    })
    expect(tool?.function.description).toContain("Edit files.")
    expect(tool?.function.description).toContain("start: begin_patch")
    expect(chat.tool_choice).toMatchObject({
      type: "function",
      function: { name: "apply_patch" },
    })
    expect(chat.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        tool_calls: [
          expect.objectContaining({
            id: "call_1",
            function: {
              name: "apply_patch",
              arguments: JSON.stringify({
                input: "*** Begin Patch\n*** End Patch",
              }),
            },
          }),
        ],
      }),
    )
    expect(chat.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_1",
        content: "ok",
      }),
    )
  })

  test("serves a Codex custom-tool request through a Chat-only upstream", async () => {
    let sent: Record<string, unknown> | undefined
    const result = (await createResponsesViaChat({
      target: {
        upstreamModelId: "test-model",
        protocol: "openai-chat-compatible",
      },
      connection: { id: "conn" },
      credential: { id: "cred" },
      payload: payload(
        [
          { role: "user", content: "fix it" },
          {
            type: "custom_tool_call",
            call_id: "call_0",
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch",
          },
          { type: "custom_tool_call_output", call_id: "call_0", output: "ok" },
        ],
        { tools: [codexCustomTool], stream: false },
      ),
      executor: async ({ payload: chatPayload }: { payload: unknown }) => {
        sent = chatPayload as Record<string, unknown>
        return {
          credentialId: "cred",
          response: {
            id: "chat-1",
            object: "chat.completion",
            created: 1,
            model: "test-model",
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "apply_patch",
                        arguments: JSON.stringify({ input: "*** Begin Patch" }),
                      },
                    },
                  ],
                },
              },
            ],
          },
        }
      },
    } as unknown as Parameters<typeof createResponsesViaChat>[0])) as {
      response: ResponsesResponse
    }
    expect(sent?.tools).toHaveLength(1)
    expect(result.response.output).toContainEqual(
      expect.objectContaining({
        type: "custom_tool_call",
        call_id: "call_1",
        name: "apply_patch",
        input: "*** Begin Patch",
      }),
    )
  })

  test("Responses translation uses structured Chat deltas after the first frame", async () => {
    const output: Array<string> = []
    let parsedChunks = 0
    const parse = spyOn(JSON, "parse")
    try {
      const result = await createResponsesViaChat({
        target: { upstreamModelId: "test-model", protocol: "windsurf-native" },
        connection: { id: "conn", protocol: "windsurf-native" },
        credential: { id: "cred" },
        payload: payload("hello", { stream: true }),
        executor: async ({ ctx }: { ctx?: RequestExecutionContext }) => {
          async function* frames(): AsyncIterable<WindsurfStreamEvent> {
            for (const text of ["hello", " 世界", "!"])
              yield {
                data: chunkFromText({
                  requestId: "twin",
                  model: "test-model",
                  text,
                  field: "content",
                }),
                ...(ctx?.collectChatStreamTwin ?
                  { collected: { content: text } }
                : {}),
              }
            yield {
              data: doneChunk({
                requestId: "twin",
                model: "test-model",
                finishReason: "stop",
              }),
              ...(ctx?.collectChatStreamTwin ?
                { collected: { finishReason: "stop" as const } }
              : {}),
            }
          }
          return { credentialId: "cred", response: frames() }
        },
      } as unknown as Parameters<typeof createResponsesViaChat>[0])
      for await (const frame of result.response as AsyncIterable<{
        data: string
      }>)
        output.push(frame.data)
      parsedChunks = parse.mock.calls.filter(([data]) =>
        String(data).includes('"object":"chat.completion.chunk"'),
      ).length
    } finally {
      parse.mockRestore()
    }
    const events = output.map(
      (data) => JSON.parse(data) as { type: string; delta?: string },
    )
    expect(
      events
        .filter((e) => e.type === "response.output_text.delta")
        .map((e) => e.delta)
        .join(""),
    ).toBe("hello 世界!")
    expect(events.at(-1)?.type).toBe("response.completed")
    expect(parsedChunks).toBe(1)
  })

  test("answers a Chat call to a custom tool as a custom_tool_call", () => {
    const request = decodeResponsesRequest(
      payload("hello", { tools: [codexCustomTool] }),
    )
    const result = {
      id: "r-custom",
      model: "test-model",
      source: { wire: "chat" as const },
      parts: [
        {
          type: "tool_call" as const,
          id: "c1",
          name: "apply_patch",
          arguments: JSON.stringify({ input: "*** Begin Patch" }),
        },
      ],
    }
    expect(encodeResponsesResult(result, request).output?.[0]).toEqual({
      type: "custom_tool_call",
      id: "ctc_r-custom_0",
      call_id: "c1",
      name: "apply_patch",
      input: "*** Begin Patch",
    })
  })

  test("streams a Chat call to a custom tool as custom_tool_call events", async () => {
    const request = decodeResponsesRequest(
      payload("hello", { tools: [codexCustomTool] }),
    )
    const out: Array<Record<string, unknown>> = []
    async function* events(): AsyncIterable<StreamEvent> {
      yield {
        type: "message_start",
        id: "r-cs",
        model: "test-model",
        source: { wire: "chat" },
      }
      yield {
        type: "part_start",
        partId: "call",
        index: 0,
        part: {
          type: "tool_call",
          id: "c1",
          name: "apply_patch",
          arguments: "",
        },
      }
      for (const text of ['{"input":"*** Begin', ' Patch"}']) {
        yield {
          type: "part_delta",
          partId: "call",
          index: 0,
          delta: { type: "tool_arguments", text },
        }
        expect(
          out.some((e) => e.type === "response.custom_tool_call_input.delta"),
        ).toBe(true)
      }
      yield { type: "part_end", partId: "call", index: 0 }
      yield {
        type: "message_end",
        stop: { reason: "tool_calls" },
        status: "completed",
      }
    }
    for await (const item of encodeResponsesStream(events(), request))
      out.push(JSON.parse(String(item.data)) as Record<string, unknown>)
    expect(out.map((e) => e.type)).not.toContain(
      "response.function_call_arguments.delta",
    )
    expect(
      out
        .filter((e) => e.type === "response.custom_tool_call_input.delta")
        .map((e) => e.delta)
        .join(""),
    ).toBe("*** Begin Patch")
    expect(out).toContainEqual(
      expect.objectContaining({
        type: "response.output_item.added",
        item: expect.objectContaining({
          type: "custom_tool_call",
          call_id: "c1",
          name: "apply_patch",
        }),
      }),
    )
    expect(out).toContainEqual(
      expect.objectContaining({
        type: "response.custom_tool_call_input.done",
        item_id: "call",
        input: "*** Begin Patch",
      }),
    )
    expect(out).toContainEqual(
      expect.objectContaining({
        type: "response.output_item.done",
        item: expect.objectContaining({
          type: "custom_tool_call",
          id: "call",
          input: "*** Begin Patch",
        }),
      }),
    )
    const completed = out.at(-1)?.response as ResponsesResponse
    expect(completed.output?.[0]).toMatchObject({
      type: "custom_tool_call",
      input: "*** Begin Patch",
    })
  })

  test("custom tool streams isolate interleaved calls with initial argument prefixes", async () => {
    const request = decodeResponsesRequest(
      payload("edit", { tools: [codexCustomTool] }),
    )
    async function* events(): AsyncIterable<StreamEvent> {
      yield {
        type: "message_start",
        id: "interleaved",
        model: "test-model",
        source: { wire: "chat" },
      }
      for (let index = 0; index < 2; index++)
        yield {
          type: "part_start",
          index,
          partId: `p${index}`,
          part: {
            type: "tool_call",
            id: `c${index}`,
            name: "apply_patch",
            arguments: '{"input":"',
          },
        }
      for (const [index, text] of [
        [0, "a\\uD83D"],
        [1, 'other"}'],
        [0, '\\uDE00"}'],
      ] as const)
        yield {
          type: "part_delta",
          index,
          partId: `p${index}`,
          delta: { type: "tool_arguments", text },
        }
      for (let index = 0; index < 2; index++)
        yield { type: "part_end", index, partId: `p${index}` }
      yield {
        type: "message_end",
        stop: { reason: "tool_calls" },
        status: "completed",
      }
    }
    const inputs = ["", ""]
    for await (const raw of encodeResponsesStream(events(), request)) {
      const event = JSON.parse(raw.data!) as {
        type: string
        output_index: number
        delta: string
      }
      expect(event.type).not.toBe("error")
      if (event.type === "response.custom_tool_call_input.delta")
        inputs[event.output_index] += event.delta
    }
    expect(inputs).toEqual(["a😀", "other"])
  })

  test("custom tool streaming keeps JSON parse work proportional to input size", async () => {
    const input = "patch line\n".repeat(3000)
    const args = JSON.stringify({ input })
    const request = decodeResponsesRequest(
      payload("edit", { tools: [codexCustomTool] }),
    )
    async function* events(): AsyncIterable<StreamEvent> {
      yield {
        type: "message_start",
        id: "r-perf",
        model: "test-model",
        source: { wire: "chat" },
      }
      yield {
        type: "part_start",
        partId: "call",
        index: 0,
        part: {
          type: "tool_call",
          id: "c1",
          name: "apply_patch",
          arguments: "",
        },
      }
      for (let i = 0; i < args.length; i += 64)
        yield {
          type: "part_delta",
          partId: "call",
          index: 0,
          delta: {
            type: "tool_arguments",
            text: args.slice(i, i + 64),
          },
        }
      yield { type: "part_end", partId: "call", index: 0 }
      yield {
        type: "message_end",
        stop: { reason: "tool_calls" },
        status: "completed",
      }
    }
    const output: Array<string> = []
    let parsedChars = 0
    const parse = spyOn(JSON, "parse")
    try {
      for await (const event of encodeResponsesStream(events(), request))
        output.push(event.data ?? "")
      parsedChars = parse.mock.calls.reduce(
        (sum, call) => sum + String(call[0]).length,
        0,
      )
    } finally {
      parse.mockRestore()
    }
    const deltas = output
      .map((data) => JSON.parse(data) as { type: string; delta?: string })
      .filter((event) => event.type === "response.custom_tool_call_input.delta")
    expect(deltas.map((event) => event.delta).join("")).toBe(input)
    // Final snapshots may parse once each; per-delta prefix reparsing is quadratic.
    expect(parsedChars).toBeLessThan(args.length * 4)
  })

  test("streams reasoning, text, usage and completion incrementally", async () => {
    async function* events(): AsyncIterable<StreamEvent> {
      yield {
        type: "message_start",
        id: "r2",
        model: "test-model",
        source: { wire: "chat" },
      }
      yield {
        type: "part_start",
        partId: "think",
        index: 0,
        part: { type: "thinking", text: "", source: { wire: "chat" } },
      }
      yield {
        type: "part_delta",
        partId: "think",
        index: 0,
        delta: { type: "thinking", text: "why" },
      }
      yield {
        type: "part_start",
        partId: "msg",
        index: 1,
        part: { type: "text", text: "" },
      }
      yield {
        type: "part_delta",
        partId: "msg",
        index: 1,
        delta: { type: "text", text: "yes" },
      }
      yield {
        type: "usage",
        usage: { source: "reported", inputTokens: 2, outputTokens: 1 },
      }
      yield {
        type: "message_end",
        stop: { reason: "complete" },
        status: "completed",
      }
    }
    const wire: Array<CopilotStreamEventLike> = []
    for await (const item of encodeResponsesStream(events())) wire.push(item)
    expect(wire.map((item) => JSON.parse(item.data ?? "{}").type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.output_item.added",
      "response.output_text.delta",
      "response.completed",
    ])
    const decoded = []
    async function* wireStream() {
      for (const item of wire) yield item
    }
    for await (const item of decodeResponsesStream(wireStream(), "test-model"))
      decoded.push(item)
    expect(
      decoded.some(
        (item) => item.type === "part_delta" && item.delta.text === "yes",
      ),
    ).toBe(true)
    expect(
      decoded.some(
        (item) => item.type === "usage" && item.usage.inputTokens === 2,
      ),
    ).toBe(true)
  })

  test("turns image_generation_call into an image the client can render", () => {
    const response: ResponsesResponse = {
      id: "img1",
      model: "test-model",
      status: "completed",
      output: [
        {
          type: "image_generation_call",
          id: "ig_1",
          status: "generating",
          output_format: "png",
          result: "aGVsbG8=",
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
    }
    const ir = decodeResponsesResult(response)
    expect(ir.parts[0]).toEqual({
      type: "image",
      id: "ig_1",
      source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" },
    })
    const encoded = encodeResponsesResult(ir)
    expect(encoded.output?.[0]).toMatchObject({
      type: "image_generation_call",
      status: "completed",
      result: "aGVsbG8=",
      output_format: "png",
    })
    expect(decodeResponsesResult(encoded).parts).toEqual(ir.parts)
    expect(
      decodeResponsesRequest(payload(encoded.output)).turns[0]?.parts,
    ).toEqual([ir.parts[0]])
    expect(
      encodeResponsesRequest(decodeResponsesRequest(payload(encoded.output)))
        .input[0],
    ).toEqual({
      type: "image_generation_call",
      id: "ig_1",
      status: "completed",
      output_format: "png",
      result: "aGVsbG8=",
    })
  })

  test("recovers an image that arrives only on output_item.done", async () => {
    async function* upstream() {
      yield {
        data: JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "image_generation_call",
            id: "ig_done",
            status: "generating",
            output_format: "jpeg",
            result: "aW1n",
          },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "img-stream",
            model: "test-model",
            status: "completed",
            output: [],
          },
        }),
      }
    }
    const decoded: Array<StreamEvent> = []
    for await (const item of decodeResponsesStream(upstream(), "test-model"))
      decoded.push(item)
    expect(decoded.find((item) => item.type === "part_start")).toMatchObject({
      part: {
        type: "image",
        source: { type: "base64", mediaType: "image/jpeg", data: "aW1n" },
      },
    })
    const wire: Array<CopilotStreamEventLike> = []
    async function* events() {
      for (const item of decoded)
        yield item.type === "part_start" || item.type === "part_end" ?
          { ...item, partId: `translated_${item.partId}` }
        : item
    }
    for await (const item of encodeResponsesStream(events())) wire.push(item)
    const types = wire.map((item) => JSON.parse(item.data ?? "{}").type)
    expect(
      types.filter((type) => type === "response.output_item.done"),
    ).toHaveLength(1)
    const done = wire
      .map((item) => JSON.parse(item.data ?? "{}"))
      .find((item) => item.type === "response.output_item.done")
    expect(done.item).toMatchObject({
      type: "image_generation_call",
      id: "ig_done",
      result: "aW1n",
      output_format: "jpeg",
    })
    const replayed: Array<StreamEvent> = []
    async function* encodedStream() {
      yield* wire
    }
    for await (const item of decodeResponsesStream(
      encodedStream(),
      "test-model",
    ))
      replayed.push(item)
    expect(
      replayed.filter(
        (item) => item.type === "part_start" && item.part.type === "image",
      ),
    ).toHaveLength(1)
  })

  test("emits final image bytes once across added, repeated done and completed events", async () => {
    const image = {
      type: "image_generation_call" as const,
      id: "ig_final",
      output_format: "webp",
      result: "ZmluYWw=",
    }
    async function* upstream() {
      for (const frame of [
        {
          type: "response.output_item.added",
          output_index: 4,
          item: { ...image, result: "cHJldmlldw==" },
        },
        {
          type: "response.image_generation_call.partial_image",
          item_id: image.id,
          partial_image_b64: "cHJldmlldw==",
        },
        { type: "response.output_item.done", item: image },
        { type: "response.output_item.done", item: image },
        {
          type: "response.completed",
          response: {
            id: "image",
            model: "m",
            status: "completed",
            output: [
              image,
              {
                ...image,
                id: "ig_second",
                output_format: "jpeg",
                result: "c2Vjb25k",
              },
            ],
          },
        },
      ])
        yield { data: JSON.stringify(frame) }
    }
    const images = []
    for await (const event of decodeResponsesStream(upstream(), "m"))
      if (event.type === "part_start" && event.part.type === "image")
        images.push(event.part.source)
    expect(images).toEqual([
      { type: "base64", mediaType: "image/webp", data: "ZmluYWw=" },
      { type: "base64", mediaType: "image/jpeg", data: "c2Vjb25k" },
    ])
  })

  test.each([
    "arguments.done",
    "output_item.done",
    "response.completed",
    "empty_output_item.done",
  ])(
    "recovers tool arguments from %s without duplicating streamed prefixes",
    async (completion) => {
      const arguments_ = '{"path":"src/对话.js","offset":37}'
      for (const prefix of ["", '{"path":', arguments_]) {
        const call = {
          type: "function_call",
          id: "fc_read",
          call_id: "call_read",
          name: "Read",
          arguments: arguments_,
        }
        async function* upstream() {
          const events = [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...call, arguments: "" },
            },
            {
              type: "response.function_call_arguments.delta",
              output_index: 0,
              delta: prefix,
            },
            // A second call must keep its own identity and already-streamed arguments.
            {
              type: "response.output_item.added",
              output_index: 1,
              item: {
                type: "function_call",
                id: "fc_other",
                call_id: "call_other",
                name: "Grep",
                arguments: "",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              output_index: 1,
              delta: '{"pattern":"pacify"}',
            },
            ...(completion === "arguments.done" ?
              [
                {
                  type: "response.function_call_arguments.done",
                  output_index: 0,
                  arguments: arguments_,
                },
              ]
            : []),
            ...(completion !== "response.completed" ?
              [
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item:
                    completion === "empty_output_item.done" ?
                      { ...call, arguments: "" }
                    : call,
                },
              ]
            : []),
            {
              type: "response.completed",
              response: {
                id: "r_args",
                model: "test-model",
                status: "completed",
                output: [
                  call,
                  {
                    type: "function_call",
                    id: "fc_other",
                    call_id: "call_other",
                    name: "Grep",
                    arguments: '{"pattern":"pacify"}',
                  },
                ],
              },
            },
          ]
          for (const event of events) {
            yield { data: JSON.stringify(event) }
            if (
              event.type === "response.function_call_arguments.done"
              || (event.type === "response.output_item.done"
                && completion !== "empty_output_item.done")
            ) {
              // Completion snapshots must repair the public stream immediately,
              // not wait until the whole upstream response has been buffered.
              expect(calls.get(0)?.arguments).toBe(arguments_)
            }
          }
        }
        const calls = new Map<
          number,
          { id: string; name: string; arguments: string }
        >()
        let finish: string | undefined
        for await (const event of encodeChatStream(
          decodeResponsesStream(upstream(), "test-model"),
        )) {
          if (event.data === "[DONE]") continue
          const chunk = JSON.parse(event.data!) as ChatCompletionChunk
          const choice = chunk.choices[0]!
          for (const call of choice.delta.tool_calls ?? []) {
            const existing = calls.get(call.index) ?? {
              id: "",
              name: "",
              arguments: "",
            }
            existing.id += call.id ?? ""
            existing.name += call.function?.name ?? ""
            existing.arguments += call.function?.arguments ?? ""
            calls.set(call.index, existing)
          }
          if (choice.finish_reason) finish = choice.finish_reason
        }
        expect([...calls.values()]).toEqual([
          { id: "call_read", name: "Read", arguments: arguments_ },
          { id: "call_other", name: "Grep", arguments: '{"pattern":"pacify"}' },
        ])
        expect(finish).toBe("tool_calls")
      }
    },
  )

  test("rejects a final tool snapshot that contradicts emitted arguments", async () => {
    async function* upstream() {
      for (const event of [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc1",
            call_id: "call1",
            name: "Read",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"path":"first.js"',
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: '{"path":"different.js"}',
        },
      ])
        yield { data: JSON.stringify(event) }
    }
    const consume = async () => {
      for await (const event of encodeChatStream(
        decodeResponsesStream(upstream(), "test-model"),
      )) {
        // Consume through the snapshot; already-sent bytes cannot be rewritten.
        void event
      }
    }
    await expect(consume()).rejects.toThrow(
      "tool arguments changed after being streamed",
    )
  })

  test("uses a terminal-only response without losing content", async () => {
    async function* terminal() {
      yield {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "terminal",
            model: "test-model",
            status: "completed",
            output: [
              { type: "reasoning", summary: [{ text: "why" }] },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "answer" }],
              },
              {
                type: "function_call",
                call_id: "call1",
                name: "search",
                arguments: "{}",
              },
            ],
          },
        }),
      }
    }
    const decoded: Array<StreamEvent> = []
    for await (const item of decodeResponsesStream(terminal(), "test-model"))
      decoded.push(item)
    expect(decoded[0]).toMatchObject({ type: "message_start", id: "terminal" })
    expect(
      decoded
        .filter((item) => item.type === "part_delta")
        .map((item) => item.delta.text),
    ).toEqual(["why", "answer"])
    expect(
      decoded.some(
        (item) => item.type === "part_start" && item.part.type === "tool_call",
      ),
    ).toBe(true)
    expect(decoded.at(-1)).toMatchObject({
      type: "message_end",
      status: "completed",
    })
  })

  test("terminal response only fills items absent from earlier deltas", async () => {
    async function* partial() {
      yield {
        data: JSON.stringify({
          type: "response.created",
          response: { id: "r3", model: "test-model" },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "m0" },
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.output_text.delta",
          output_index: 0,
          delta: "first",
        }),
      }
      yield {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "r3",
            model: "test-model",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "first" }],
              },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "second" }],
              },
            ],
          },
        }),
      }
    }
    const texts: Array<string> = []
    for await (const item of decodeResponsesStream(partial(), "test-model")) {
      if (item.type === "part_delta" && item.delta.type === "text")
        texts.push(item.delta.text)
    }
    expect(texts).toEqual(["first", "second"])
  })

  test("DONE without completion marks the response incomplete", async () => {
    async function* unfinished() {
      yield {
        data: JSON.stringify({
          type: "response.created",
          response: { id: "r4", model: "test-model" },
        }),
      }
      yield { data: "[DONE]" }
    }
    const decoded: Array<StreamEvent> = []
    for await (const item of decodeResponsesStream(unfinished(), "test-model"))
      decoded.push(item)
    expect(decoded.at(-1)).toMatchObject({
      type: "message_end",
      status: "incomplete",
      stop: { reason: "incomplete" },
    })
  })

  test("emits content before the upstream stream finishes", async () => {
    let upstreamFinished = false
    async function* upstream() {
      try {
        yield {
          data: JSON.stringify({
            type: "response.created",
            response: { id: "r5", model: "test-model" },
          }),
        }
        yield {
          data: JSON.stringify({
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "m0" },
          }),
        }
        yield {
          data: JSON.stringify({
            type: "response.output_text.delta",
            output_index: 0,
            delta: "first",
          }),
        }
        yield {
          data: JSON.stringify({
            type: "response.completed",
            response: { id: "r5", model: "test-model", output: [] },
          }),
        }
      } finally {
        upstreamFinished = true
      }
    }

    const stream = decodeResponsesStream(upstream(), "test-model")[
      Symbol.asyncIterator
    ]()
    expect((await stream.next()).value?.type).toBe("message_start")
    expect((await stream.next()).value?.type).toBe("part_start")
    expect((await stream.next()).value).toMatchObject({
      type: "part_delta",
      delta: { type: "text", text: "first" },
    })
    expect(upstreamFinished).toBe(false)
    await stream.return?.()
  })
})
