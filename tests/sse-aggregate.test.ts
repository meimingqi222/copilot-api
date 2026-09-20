import { describe, expect, test } from "bun:test"

import type { CopilotStreamEvent } from "~/services/copilot/create-chat-completions"

import { aggregateSseToResponse } from "~/services/protocols/sse-aggregate"

/**
 * 非流式聚合必须与流式 normalize 走同一条别名链：上游不用
 * `reasoning_content` 拼写时，聚合不能把思考弄丢，也不能复制出两份。
 */

function sseEvent(
  delta: Record<string, unknown>,
  finishReason: string | null = "",
): CopilotStreamEvent {
  return {
    data: JSON.stringify({
      id: "agg-test",
      model: "upstream-model",
      object: "chat.completion.chunk",
      created: 1789018553,
      choices: [
        { index: 0, delta, logprobs: null, finish_reason: finishReason },
      ],
      usage: null,
    }),
  }
}

async function* toolCallStream(
  toolCalls: Array<Record<string, unknown>>,
): AsyncGenerator<CopilotStreamEvent> {
  for (const toolCall of toolCalls) {
    yield sseEvent({ tool_calls: [toolCall] })
  }
  yield { data: "[DONE]" }
}

async function aggregate(
  deltas: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  async function* stream(): AsyncGenerator<CopilotStreamEvent> {
    for (const delta of deltas) yield sseEvent(delta)
    yield { data: "[DONE]" }
  }
  const response = await aggregateSseToResponse(stream(), "agg-model")
  return response.choices.map(
    (choice) => choice.message as unknown as Record<string, unknown>,
  )
}

describe("aggregateSseToResponse reasoning aliases", () => {
  test("assembles reasoning_text deltas into reasoning_content", async () => {
    const [message] = await aggregate([
      { reasoning_text: "9.", reasoning_content: "" },
      { reasoning_text: "11", reasoning_content: "" },
    ])
    expect(message?.reasoning_content).toBe("9.11")
    expect("reasoning_text" in (message ?? {})).toBe(false)
  })

  test("keeps assembling reasoning_content deltas", async () => {
    const [message] = await aggregate([
      { reasoning_content: "a" },
      { reasoning_content: "b" },
    ])
    expect(message?.reasoning_content).toBe("ab")
  })

  test("an empty reasoning_content does not shadow a populated alias", async () => {
    const [message] = await aggregate([
      { reasoning_content: "", thinking: "why" },
    ])
    expect(message?.reasoning_content).toBe("why")
  })

  test("canonical reasoning_content wins over a non-empty alias", async () => {
    // The streaming path (`routes/chat-completions/normalize.ts`) gives
    // `reasoning_content` precedence; the aggregator must agree, or the same
    // upstream chunk yields different text depending on `stream`.
    const [message] = await aggregate([
      { reasoning_content: "mine", reasoning_text: "theirs" },
    ])
    expect(message?.reasoning_content).toBe("mine")
  })

  test("omits reasoning_content when no delta carries thinking", async () => {
    const [message] = await aggregate([{ content: "plain" }])
    expect(message?.content).toBe("plain")
    expect("reasoning_content" in (message ?? {})).toBe(false)
  })

  test("compacts holes from non-contiguous tool_call indexes", async () => {
    const response = await aggregateSseToResponse(
      toolCallStream([
        {
          index: 0,
          id: "call_0",
          type: "function",
          function: { name: "read", arguments: "{}" },
        },
        // A spec-violating upstream that skips index 1 must not leave a hole.
        {
          index: 2,
          id: "call_2",
          type: "function",
          function: { name: "bash", arguments: "{}" },
        },
      ]),
      "agg-model",
    )
    const message = response.choices[0]?.message as unknown as Record<
      string,
      unknown
    >
    const toolCalls = message.tool_calls as Array<unknown>
    expect(toolCalls).toHaveLength(2)
    expect(toolCalls.every((toolCall) => toolCall !== undefined)).toBe(true)
  })

  test("handles a very large tool_call index without allocating a sparse array", async () => {
    const response = await aggregateSseToResponse(
      toolCallStream([
        {
          index: 1_000_000_000,
          id: "call_large",
          type: "function",
          function: { name: "read", arguments: "{}" },
        },
      ]),
      "agg-model",
    )
    const toolCalls = response.choices[0]?.message
      .tool_calls as unknown as Array<Record<string, unknown>>
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]?.index).toBe(1_000_000_000)
    expect(toolCalls[0]?.id).toBe("call_large")
  })
})
