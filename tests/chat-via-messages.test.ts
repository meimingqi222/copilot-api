import { describe, expect, test } from "bun:test"

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type { AnthropicResponse } from "~/services/protocols/anthropic"

import {
  createInitialStreamState,
  translateChunkToAnthropicEvents,
} from "~/services/protocols/anthropic"
import { createChatViaMessages } from "~/services/protocols/chat-via-messages"
import {
  DEFAULT_VIA_MESSAGES_MAX_TOKENS,
  translateAnthropicResponseToChat,
  translateAnthropicStreamToChatEvents,
  translateChatPayloadToAnthropic,
} from "~/services/protocols/openai"

const basePayload = (
  overrides: Partial<ChatCompletionsPayload> = {},
): ChatCompletionsPayload => ({
  model: "claude-sonnet-4",
  messages: [{ role: "user", content: "hi" }],
  max_tokens: 128,
  ...overrides,
})

async function translateFullStream(
  events: Array<{ data?: string }>,
): Promise<Array<ChatCompletionChunk>> {
  // Sync generator is sufficient (no upstream I/O); `for await` accepts it.
  const stream = (function* () {
    for (const event of events) yield event
  })() as unknown as AsyncIterable<{ data?: string }>
  const frames: Array<string> = []
  for await (const frame of translateAnthropicStreamToChatEvents(stream)) {
    frames.push(frame.data ?? "")
  }
  expect(frames.at(-1)).toBe("[DONE]")
  return frames
    .slice(0, -1)
    .map((frame) => JSON.parse(frame) as ChatCompletionChunk)
}

const messageStart = (
  id: string,
  model = "claude-sonnet-4",
  usage = { input_tokens: 10, output_tokens: 0 },
) => ({
  data: JSON.stringify({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  }),
})

function makeChatChunk(
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
  usage?: ChatCompletionChunk["usage"],
): ChatCompletionChunk {
  return {
    id: "msg_interleaved",
    object: "chat.completion.chunk",
    created: 1,
    model: "swe-1-6",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    ...(usage ? { usage } : {}),
  }
}

describe("translateChatPayloadToAnthropic (chat → messages request)", () => {
  test("maps system/developer, params, tools, and user metadata", () => {
    const result = translateChatPayloadToAnthropic(
      basePayload({
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "developer", content: "extra instructions" },
          { role: "user", content: "hi" },
        ],
        temperature: 0.5,
        top_p: 0.9,
        stop: ["\n", "END"],
        user: "user-123",
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          },
        ],
        tool_choice: "auto",
      }),
    )

    expect(result.model).toBe("claude-sonnet-4")
    expect(result.system).toBe("You are helpful\n\nextra instructions")
    expect(result.temperature).toBe(0.5)
    expect(result.top_p).toBe(0.9)
    expect(result.stop_sequences).toEqual(["\n", "END"])
    expect(result.metadata?.user_id).toBe("user-123")
    expect(result.tools?.[0]).toEqual({
      name: "get_weather",
      description: "Get weather",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    })
    expect(result.tool_choice).toEqual({ type: "auto" })
    expect(result.messages).toEqual([{ role: "user", content: "hi" }])
  })

  test("merges consecutive tool messages and following user text into one user turn", () => {
    const result = translateChatPayloadToAnthropic(
      basePayload({
        messages: [
          {
            role: "assistant",
            content: "calling tools",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: '{"cmd":"pwd"}' },
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "ls", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "/home" },
          { role: "tool", tool_call_id: "call_2", content: "[" },
          { role: "user", content: "then continue" },
        ],
      }),
    )

    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling tools" },
          {
            type: "tool_use",
            id: "call_1",
            name: "bash",
            input: { cmd: "pwd" },
          },
          { type: "tool_use", id: "call_2", name: "ls", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "/home" },
          { type: "tool_result", tool_use_id: "call_2", content: "[" },
          { type: "text", text: "then continue" },
        ],
      },
    ])
  })

  test("maps tool_choice required/function to any/tool", () => {
    expect(
      translateChatPayloadToAnthropic(
        basePayload({
          tool_choice: "required",
          tools: [
            { type: "function", function: { name: "f", parameters: {} } },
          ],
        }),
      ).tool_choice,
    ).toEqual({ type: "any" })
    expect(
      translateChatPayloadToAnthropic(
        basePayload({
          tool_choice: { type: "function", function: { name: "f" } },
        }),
      ).tool_choice,
    ).toEqual({ type: "tool", name: "f" })
  })

  test("maps reasoning_effort to adaptive thinking + narrowed effort", () => {
    const effortFor = (effort: string) =>
      translateChatPayloadToAnthropic(
        basePayload({
          reasoning_effort:
            effort as ChatCompletionsPayload["reasoning_effort"],
        }),
      )

    expect(effortFor("minimal")).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    })
    expect(effortFor("medium")).toMatchObject({
      output_config: { effort: "medium" },
    })
    // high/xhigh narrow to the highest Anthropic tier.
    expect(effortFor("high")).toMatchObject({
      output_config: { effort: "high" },
    })
    expect(effortFor("xhigh")).toMatchObject({
      output_config: { effort: "high" },
    })
    // "none"/"auto" → omit thinking entirely.
    expect(effortFor("none").thinking).toBeUndefined()
    expect(effortFor("none").output_config).toBeUndefined()
    expect(effortFor("auto").thinking).toBeUndefined()
    expect(basePayload().thinking).toBeUndefined()
  })

  test("defaults max_tokens to 64000 when the client omits it", () => {
    const result = translateChatPayloadToAnthropic(
      basePayload({ max_tokens: undefined }),
    )
    expect(result.max_tokens).toBe(DEFAULT_VIA_MESSAGES_MAX_TOKENS)
  })

  test("preserves signed historical reasoning as thinking, strips unsigned", () => {
    const result = translateChatPayloadToAnthropic(
      basePayload({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "step 1", signature: "sig_1" },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "no signature here" }],
          },
          {
            role: "assistant",
            content: "plain text",
            reasoning_text: "unsigned",
          },
          { role: "user", content: "continue" },
        ],
      }),
    )

    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "step 1", signature: "sig_1" }],
    })
    // Unsigned historical thinking / reasoning_text are stripped, leaving a
    // valid placeholder text block instead of an empty assistant content list.
    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: " " }],
    })
    expect(result.messages[2]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "plain text" }],
    })
  })

  test("keeps user content valid when all image parts are unsupported", () => {
    const result = translateChatPayloadToAnthropic(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.com/image.png" },
              },
            ],
          },
        ],
      }),
    )
    expect(result.messages).toEqual([
      { role: "user", content: [{ type: "text", text: " " }] },
    ])
  })

  test("does not inject a placeholder when merging empty user content into a tool-result turn", () => {
    const result = translateChatPayloadToAnthropic(
      basePayload({
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: '{"cmd":"pwd"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "/home" },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.com/unsupported.png" },
              },
            ],
          },
        ],
      }),
    )
    // The merged turn is kept non-empty by the tool_result alone; the
    // unsupported image adds no placeholder text block.
    expect(result.messages[1]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "/home",
        },
      ],
    })
  })

  test("maps base64 image parts to Anthropic image blocks, drops remote URLs", () => {
    const result = translateChatPayloadToAnthropic(
      basePayload({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,iVBORw0KGgo=",
                },
              },
              {
                type: "image_url",
                image_url: { url: "https://example.com/x.png" },
              },
            ],
          },
        ],
      }),
    )

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ],
      },
    ])
  })
})

describe("translateAnthropicResponseToChat (non-streaming response)", () => {
  const response: AnthropicResponse = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "step 1" },
      { type: "text", text: "Answer" },
      { type: "tool_use", id: "toolu_1", name: "bash", input: { cmd: "pwd" } },
    ],
    model: "claude-sonnet-4",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
  }

  test("maps thinking → reasoning_content, tool_use → tool_calls, stop_reason → finish_reason", () => {
    const result = translateAnthropicResponseToChat(response)

    expect(result.id).toBe("msg_1")
    expect(result.object).toBe("chat.completion")
    expect(result.choices[0].finish_reason).toBe("tool_calls")
    expect(result.choices[0].message.role).toBe("assistant")
    expect(result.choices[0].message.content).toBe("Answer")
    expect(result.choices[0].message.reasoning_content).toBe("step 1")
    expect(result.choices[0].message.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "bash", arguments: '{"cmd":"pwd"}' },
      },
    ])
  })

  test("preserves interleaved thinking order in non-streaming responses", () => {
    const result = translateAnthropicResponseToChat({
      ...response,
      content: [
        { type: "text", text: "before" },
        { type: "thinking", thinking: "middle", signature: "sig" },
        { type: "text", text: "after" },
      ],
    })

    expect(result.choices[0].message.content).toEqual([
      { type: "text", text: "before" },
      { type: "reasoning", text: "middle", signature: "sig" },
      { type: "text", text: "after" },
    ])
  })

  test("preserves thinking signatures in reasoning_details", () => {
    const result = translateAnthropicResponseToChat({
      ...response,
      content: [
        { type: "thinking", thinking: "step 1", signature: "sig_1" },
        { type: "text", text: "Answer" },
      ],
    })
    expect(result.choices[0].message.reasoning_details).toEqual([
      { type: "reasoning.text", text: "step 1", signature: "sig_1" },
    ])

    const nextRequest = translateChatPayloadToAnthropic(
      basePayload({
        messages: [
          {
            role: "assistant",
            content: "Answer",
            reasoning_content: "step 1",
            reasoning_details: [
              { type: "reasoning.text", text: "step 1", signature: "sig_1" },
            ],
          },
        ],
      }),
    )
    expect(nextRequest.messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "step 1", signature: "sig_1" },
        { type: "text", text: "Answer" },
      ],
    })
  })

  test("reverse-maps usage with cache buckets folded into prompt_tokens", () => {
    const result = translateAnthropicResponseToChat(response)
    expect(result.usage).toEqual({
      prompt_tokens: 13,
      completion_tokens: 5,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 3 },
    })
  })

  test("maps end_turn/max_tokens stop reasons", () => {
    expect(
      translateAnthropicResponseToChat({
        ...response,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }).choices[0].finish_reason,
    ).toBe("stop")
    expect(
      translateAnthropicResponseToChat({
        ...response,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "max_tokens",
      }).choices[0].finish_reason,
    ).toBe("length")
  })
})

describe("translateAnthropicStreamToChatEvents (streaming)", () => {
  test("emits text chunks and a terminal chunk with usage", async () => {
    const chunks = await translateFullStream([
      messageStart("msg_1"),
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      {
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        }),
      },
      { data: JSON.stringify({ type: "message_stop" }) },
    ])

    expect(chunks[0]).toMatchObject({
      id: "msg_1",
      object: "chat.completion.chunk",
      model: "claude-sonnet-4",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    })
    expect(chunks[1]).toMatchObject({
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    })
    expect(chunks[2]).toMatchObject({
      choices: [
        { index: 0, delta: { content: " world" }, finish_reason: null },
      ],
    })
    expect(chunks[3]).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  })

  test("emits tool_calls fragments from input_json_delta", async () => {
    const chunks = await translateFullStream([
      messageStart("msg_2"),
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: {},
          },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"cmd":' },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"pwd"}' },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      {
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 8 },
        }),
      },
      { data: JSON.stringify({ type: "message_stop" }) },
    ])

    expect(chunks[1]).toMatchObject({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "toolu_1",
                type: "function",
                function: { name: "bash", arguments: "" },
              },
            ],
          },
        },
      ],
    })
    expect(chunks[2]).toMatchObject({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }],
          },
        },
      ],
    })
    expect(chunks[3]).toMatchObject({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }],
          },
        },
      ],
    })
    expect(chunks[4]).toMatchObject({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })
  })

  test("emits reasoning_content and signature deltas from thinking blocks", async () => {
    const chunks = await translateFullStream([
      messageStart("msg_3"),
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let me think" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig_abc" },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "done" },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
      {
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 20 },
        }),
      },
      { data: JSON.stringify({ type: "message_stop" }) },
    ])

    expect(chunks[1]).toMatchObject({
      choices: [{ index: 0, delta: { reasoning_content: "Let me think" } }],
    })
    expect(chunks[2]).toMatchObject({
      choices: [{ index: 0, delta: { signature: "sig_abc" } }],
    })
    expect(chunks[3]).toMatchObject({
      choices: [{ index: 0, delta: { content: "done" } }],
    })
  })

  test("preserves interleaved reasoning segments after visible text", () => {
    const state = createInitialStreamState()

    const events = [
      ...translateChunkToAnthropicEvents(
        makeChatChunk({ reasoning_text: "first thought" }),
        state,
      ),
      ...translateChunkToAnthropicEvents(
        makeChatChunk({ content: "first answer" }),
        state,
      ),
      ...translateChunkToAnthropicEvents(
        makeChatChunk({ reasoning_text: "second thought" }),
        state,
      ),
      ...translateChunkToAnthropicEvents(
        makeChatChunk({ content: "second answer" }),
        state,
      ),
      ...translateChunkToAnthropicEvents(
        makeChatChunk({}, "stop", {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
        }),
        state,
      ),
    ]

    const blockTypes = events.flatMap((event) => {
      if (event.type !== "content_block_start") return []
      return [event.content_block.type === "thinking" ? "thinking" : "text"]
    })
    expect(blockTypes).toEqual(["thinking", "text", "thinking", "text"])

    const thinkingTexts = events.flatMap((event) => {
      if (
        event.type !== "content_block_delta"
        || event.delta.type !== "thinking_delta"
      ) {
        return []
      }
      return [event.delta.thinking]
    })
    expect(thinkingTexts).toEqual(["first thought", "second thought"])
  })

  test("skips ping events", async () => {
    const chunks = await translateFullStream([
      messageStart("msg_4"),
      { data: JSON.stringify({ type: "ping" }) },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      {
        data: JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      },
      { data: JSON.stringify({ type: "message_stop" }) },
    ])

    expect(
      chunks.map((c) => c.choices[0].delta.content).filter(Boolean),
    ).toEqual(["ok"])
  })
})

describe("createChatViaMessages (wrapper)", () => {
  const target: RouteTarget = {
    connectionId: "conn-1",
    connectionName: "conn-1",
    protocol: "anthropic-compatible",
    credentialId: "cred-1",
    publicModelId: "claude-sonnet-4",
    upstreamModelId: "claude-sonnet-4",
    endpoint: "messages",
    connectionPriority: 0,
    connectionWeight: 1,
    credentialPriority: 0,
    credentialWeight: 1,
  }
  const credential: ApiCredential = {
    id: "cred-1",
    authMode: "bearer",
    value: "sk-test",
    enabled: true,
    priority: 0,
    status: "ready",
    createdAt: Date.now(),
  }
  const connection: ProviderConnection = {
    id: "conn-1",
    name: "conn-1",
    protocol: "anthropic-compatible",
    baseUrl: "https://api.anthropic.test",
    enabled: true,
    priority: 0,
    credentials: [credential],
    createdAt: Date.now(),
  }
  const anthropicResponse: AnthropicResponse = {
    id: "msg_9",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model: "claude-sonnet-4",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 1 },
  }

  test("translates and delegates non-streaming requests", async () => {
    const result = await createChatViaMessages({
      target,
      connection,
      credential,
      payload: basePayload(),
      messagesExecutor: (params) => {
        expect(params.payload.model).toBe("claude-sonnet-4")
        expect(params.payload.max_tokens).toBe(128)
        return Promise.resolve({
          credentialId: "cred-1",
          response: anthropicResponse as unknown as Record<string, unknown>,
        })
      },
    })

    expect(result.credentialId).toBe("cred-1")
    const response = result.response as ChatCompletionResponse
    expect(response.object).toBe("chat.completion")
    expect(response.choices[0].message.content).toBe("ok")
    expect(response.choices[0].finish_reason).toBe("stop")
  })
})
