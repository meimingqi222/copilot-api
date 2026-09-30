import { describe, expect, test } from "bun:test"

import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestIR, StreamEvent } from "~/services/ir/types"

import { planTranslation } from "~/services/ir"
import { encodeChatRequest } from "~/services/ir/codecs/messages-chat/request"
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

function payload(
  input: unknown,
  extra: Record<string, unknown> = {},
): ResponsesPayload {
  return { model: "test-model", input, ...extra } as ResponsesPayload
}

describe("Responses IR request codec", () => {
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
        chatExecutor: async () => {
          called = true
          throw new Error("must not call upstream")
        },
      } as unknown as Parameters<typeof createResponsesViaChat>[0]),
    ).rejects.toThrow("target cannot receive file content")
    expect(called).toBe(false)
  })
})

describe("Responses IR result and stream codec", () => {
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
