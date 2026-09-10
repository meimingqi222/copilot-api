import { describe, test, expect } from "bun:test"

import type { CopilotStreamEvent } from "~/services/copilot/create-chat-completions"

import { sanitizeCodebuddyStream } from "~/services/protocols/codebuddy-native"

/**
 * CodeBuddy 上游每个 chunk 都携带空占位字段（content: ""、tool_calls: []、
 * refusal: ""、function_call: null、extra_fields: null、finish_reason: ""）。
 * 按"字段是否存在"判断思考/正文阶段的客户端会把每个 token 当成一次块切换。
 * 清洗后应只保留有实际内容的字段。
 */

function upstreamEvent(delta: Record<string, unknown>): CopilotStreamEvent {
  return {
    data: JSON.stringify({
      id: "cmb-test",
      model: "deepseek-v4.1-flash",
      object: "chat.completion.chunk",
      created: 1789018553,
      choices: [
        {
          index: 0,
          delta,
          logprobs: null,
          finish_reason: "",
        },
      ],
      usage: null,
    }),
  }
}

async function collect(
  events: AsyncIterable<CopilotStreamEvent>,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const event of events) {
    if (!event.data || event.data === "[DONE]") continue
    out.push(JSON.parse(event.data) as Record<string, unknown>)
  }
  return out
}

describe("codebuddy stream sanitizer", () => {
  test("reasoning-phase chunks keep only reasoning_content", async () => {
    const upstream = (async function* () {
      yield upstreamEvent({
        role: "assistant",
        content: "",
        reasoning_content: "",
        function_call: null,
        refusal: "",
        tool_calls: [],
        extra_fields: null,
      })
      yield upstreamEvent({
        content: "",
        reasoning_content: "9.11",
        function_call: null,
        refusal: "",
        tool_calls: [],
        extra_fields: null,
      })
    })()

    const chunks = await collect(sanitizeCodebuddyStream(upstream))
    expect(chunks.length).toBe(2)
    expect(chunks[0]?.choices).toEqual([
      {
        index: 0,
        delta: { role: "assistant" },
        logprobs: null,
        finish_reason: null,
      },
    ])
    expect(chunks[1]?.choices).toEqual([
      {
        index: 0,
        delta: { reasoning_content: "9.11" },
        logprobs: null,
        finish_reason: null,
      },
    ])
  })

  test("content-phase chunks keep only content", async () => {
    const upstream = (async function* () {
      yield upstreamEvent({
        content: "9.8",
        reasoning_content: "",
        function_call: null,
        refusal: "",
        tool_calls: [],
        extra_fields: null,
      })
    })()

    const chunks = await collect(sanitizeCodebuddyStream(upstream))
    expect(chunks[0]?.choices).toEqual([
      {
        index: 0,
        delta: { content: "9.8" },
        logprobs: null,
        finish_reason: null,
      },
    ])
  })

  test("real tool_calls and finish_reason are preserved", async () => {
    const upstream = (async function* () {
      yield upstreamEvent({
        content: "",
        reasoning_content: "",
        function_call: null,
        refusal: "",
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
        extra_fields: null,
      })
      yield {
        data: JSON.stringify({
          id: "cmb-test",
          model: "deepseek-v4.1-flash",
          object: "chat.completion.chunk",
          created: 1789018553,
          choices: [
            { index: 0, delta: {}, logprobs: null, finish_reason: "stop" },
          ],
          usage: null,
        }),
      }
      yield { data: "[DONE]" }
    })()

    const chunks = await collect(sanitizeCodebuddyStream(upstream))
    const first = chunks[0] as {
      choices: Array<{
        delta: { tool_calls?: Array<unknown> }
        finish_reason: unknown
      }>
    }
    expect(first.choices[0]?.delta.tool_calls).toHaveLength(1)
    const last = chunks[1] as { choices: Array<{ finish_reason: string }> }
    expect(last.choices[0]?.finish_reason).toBe("stop")
  })
})
