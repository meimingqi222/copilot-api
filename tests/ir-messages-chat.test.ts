import { describe, expect, test } from "bun:test"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/protocols/chat/types"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/services/protocols/anthropic/types"
import {
  decodeChatRequest,
  decodeChatResponse,
  decodeChatStream,
  decodeMessagesRequest,
  decodeMessagesResponse,
  decodeMessagesStream,
  encodeChatRequest,
  encodeChatResponse,
  encodeChatStream,
  encodeMessagesRequest,
  encodeMessagesResponse,
  encodeMessagesStream,
} from "~/services/ir/codecs/messages-chat"

describe("Messages and Chat IR codecs", () => {
  test("preserves each signed thinking block independently", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "first", signature: "sig-1" },
            { type: "thinking", thinking: "second", signature: "sig-2" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    }
    const ir = decodeMessagesRequest(payload)
    const chat = encodeChatRequest(ir, { preserveHistoricalReasoning: true })
    expect(chat.messages[0]?.reasoning_details).toEqual([
      { type: "reasoning.text", text: "first", signature: "sig-1" },
      { type: "reasoning.text", text: "second", signature: "sig-2" },
    ])
    const replay = encodeMessagesRequest(decodeChatRequest(chat))
    expect(replay.messages[0]?.content).toEqual(payload.messages[0]?.content)
  })

  test("moves every tool_result image directly after its matching Chat tool message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [
                { type: "text", text: "first" },
                {
                  type: "image",
                  source: { type: "url", url: "https://example.test/1.png" },
                },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "call_2",
              content: [
                { type: "text", text: "second" },
                {
                  type: "image",
                  source: { type: "url", url: "https://example.test/2.png" },
                },
              ],
            },
            { type: "text", text: "compare" },
          ],
        },
      ],
    }
    const chat = encodeChatRequest(decodeMessagesRequest(payload))
    expect(chat.messages.map((message) => message.role)).toEqual([
      "tool",
      "user",
      "tool",
      "user",
      "user",
    ])
    expect(chat.messages[0]?.tool_call_id).toBe("call_1")
    expect(chat.messages[1]?.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.test/1.png" } },
    ])
    expect(chat.messages[2]?.tool_call_id).toBe("call_2")
    expect(chat.messages[3]?.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.test/2.png" } },
    ])
    expect(chat.messages[4]?.content).toBe("compare")
  })

  test("retains cache breakpoints and base64 images in Chat to Messages request", () => {
    const messages = encodeMessagesRequest(
      decodeChatRequest({
        model: "claude-sonnet-4",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "describe",
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,YQ==" },
              },
            ],
          },
        ],
      }),
    )
    expect(messages.messages[0]?.content).toEqual([
      {
        type: "text",
        text: "describe",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "YQ==" },
      },
    ])
  })

  test("keeps a system cache breakpoint in Messages blocks", () => {
    const messages = encodeMessagesRequest(
      decodeChatRequest({
        model: "claude-sonnet-4",
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "instructions",
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
            ],
          },
          { role: "user", content: "hi" },
        ],
      }),
    )
    expect(messages.system).toEqual([
      {
        type: "text",
        text: "instructions",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ])
  })

  test("substitutes empty input for malformed historical tool arguments", () => {
    // A truncated tool-call (finish_reason "length" mid-JSON) has no faithful
    // `tool_use.input` representation, but the replay must still go through —
    // matching encodeMessagesResponse on the response side.
    const request = decodeChatRequest({
      model: "claude-sonnet-4",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "run", arguments: "{" },
            },
          ],
        },
      ],
    })
    const messages = encodeMessagesRequest(request).messages
    expect(messages[0]?.content).toEqual([
      { type: "tool_use", id: "call_1", name: "run", input: {} },
    ])
  })

  test("filters allowed tools and keeps named or required Chat tool choice", () => {
    const request = decodeChatRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "run" }],
      tools: [
        { type: "function", function: { name: "one", parameters: {} } },
        { type: "function", function: { name: "two", parameters: {} } },
      ],
    })
    request.toolChoice = { type: "allowed", mode: "required", names: ["two"] }
    const required = encodeChatRequest(request)
    expect(required.tools?.map((tool) => tool.function.name)).toEqual(["two"])
    expect(required.tool_choice).toBe("required")
    request.toolChoice = { type: "tool", name: "two" }
    expect(encodeChatRequest(request).tool_choice).toEqual({
      type: "function",
      function: { name: "two" },
    })
    request.toolChoice = { type: "allowed", mode: "auto", names: [] }
    expect(encodeChatRequest(request).tools).toBeUndefined()
    expect(encodeChatRequest(request).tool_choice).toBe("none")
  })

  test("merges adjacent assistant turns and keeps signed thinking ahead of tool calls", () => {
    const messages = encodeMessagesRequest(
      decodeChatRequest({
        model: "claude-sonnet-4",
        messages: [
          {
            role: "assistant",
            content: null,
            reasoning_content: "reason",
            signature: "sig",
          },
          {
            role: "assistant",
            content: "answer",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: "{}" },
              },
            ],
          },
        ],
      }),
    )
    expect(messages.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reason", signature: "sig" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "call_1", name: "read", input: {} },
        ],
      },
    ])
  })

  test("normalizes usage without counting cache twice", () => {
    const response: AnthropicResponse = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4",
      content: [
        { type: "thinking", thinking: "reason", signature: "sig" },
        { type: "text", text: "answer" },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 2,
        output_tokens: 3,
      },
    }
    const chat = encodeChatResponse(decodeMessagesResponse(response))
    expect(chat.choices[0]?.message.reasoning_details).toBeUndefined()
    expect(chat.choices[0]?.message.signature).toBe("sig")
    expect(chat.usage).toEqual({
      prompt_tokens: 17,
      completion_tokens: 3,
      total_tokens: 20,
      prompt_tokens_details: {
        cached_tokens: 10,
        cache_creation_input_tokens: 2,
      },
    })
    const replay = encodeMessagesResponse(decodeChatResponse(chat))
    expect(replay.usage).toEqual(response.usage)
    expect(replay.content).toEqual(response.content)
  })

  test("does not duplicate details echoed by a joined reasoning alias", () => {
    const response: ChatCompletionResponse = {
      id: "chat_1",
      object: "chat.completion",
      created: 1,
      model: "claude",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "answer",
            reasoning_content: "first\n\nsecond",
            reasoning_details: [
              { text: "first", signature: "sig-1" },
              { text: "second", signature: "sig-2" },
            ],
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }
    const ir = decodeChatResponse(response)
    expect(
      ir.parts
        .filter((part) => part.type === "thinking")
        .map((part) => part.text),
    ).toEqual(["first", "second"])
    expect(encodeMessagesResponse(ir).content).toEqual([
      { type: "thinking", thinking: "first", signature: "sig-1" },
      { type: "thinking", thinking: "second", signature: "sig-2" },
      { type: "text", text: "answer" },
    ])
  })

  test("marks a missing Chat finish reason as unknown in IR", () => {
    const response = {
      id: "chat_1",
      object: "chat.completion",
      created: 1,
      model: "claude",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "answer" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    } as unknown as ChatCompletionResponse
    expect(decodeChatResponse(response).stop?.reason).toBe("unknown")
  })

  test("streams thinking, signature, text and terminal usage through IR", async () => {
    const chunks: Array<ChatCompletionChunk> = [
      {
        id: "chat_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", reasoning_content: "thought" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "chat_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "claude-sonnet-4",
        choices: [
          {
            index: 0,
            delta: { signature: "sig", content: "answer" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "chat_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "claude-sonnet-4",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ]
    async function* source() {
      for (const chunk of chunks) yield { data: JSON.stringify(chunk) }
      yield { data: "[DONE]" }
    }
    const events = []
    for await (const event of encodeMessagesStream(decodeChatStream(source())))
      events.push(event)
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(
      events.find(
        (event) =>
          event.type === "content_block_delta"
          && event.delta.type === "signature_delta",
      ),
    ).toBeDefined()
    expect(
      events.find((event) => event.type === "message_delta")?.usage
        ?.output_tokens,
    ).toBe(2)
  })

  test("uses reasoning_details when streaming aliases are empty without echo duplication", async () => {
    const chunks: Array<ChatCompletionChunk> = [
      {
        id: "chat_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "claude",
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "",
              reasoning_details: [{ text: "detail" }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "chat_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "claude",
        choices: [
          {
            index: 0,
            delta: {
              reasoning_text: "alias",
              reasoning_details: [{ text: "alias" }],
            },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
    ]
    async function* source() {
      for (const chunk of chunks) yield { data: JSON.stringify(chunk) }
      yield { data: "[DONE]" }
    }
    const reasoning: Array<string> = []
    for await (const event of decodeChatStream(source()))
      if (event.type === "part_delta" && event.delta.type === "thinking")
        reasoning.push(event.delta.text)
    expect(reasoning).toEqual(["detail", "alias"])
  })

  test("does not mark a truncated Chat stream as a successful Messages response", async () => {
    const chunk: ChatCompletionChunk = {
      id: "chat_1",
      object: "chat.completion.chunk",
      created: 1,
      model: "claude",
      choices: [
        {
          index: 0,
          delta: { content: "partial" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }
    async function* source() {
      yield { data: JSON.stringify(chunk) }
      yield { data: "[DONE]" }
    }
    const events = []
    for await (const event of encodeMessagesStream(decodeChatStream(source())))
      events.push(event)
    expect(events.at(-1)?.type).toBe("error")
    expect(events.some((event) => event.type === "message_stop")).toBe(false)
  })

  test("streams Messages tool call to Chat chunks with stable tool index", async () => {
    const raw = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude",
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call_1",
          name: "read",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"x"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ]
    async function* source() {
      for (const item of raw) yield { data: JSON.stringify(item) }
    }
    const frames = []
    for await (const frame of encodeChatStream(decodeMessagesStream(source())))
      frames.push(frame.data)
    const chunks = frames
      .slice(0, -1)
      .map((frame) => JSON.parse(frame ?? "") as ChatCompletionChunk)
    expect(
      chunks
        .flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? [])
        .map((call) => call.index),
    ).toEqual([0, 0, 0])
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls")
    expect(frames.at(-1)).toBe("[DONE]")
  })
})
