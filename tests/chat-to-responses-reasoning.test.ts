import { describe, expect, test } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import { translateChatCompletionsStreamToResponses } from "~/services/copilot/chat-to-responses"

async function collectStreamEvents(
  stream: AsyncIterable<{ data?: string }>,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  for await (const frame of stream) {
    events.push(JSON.parse(frame.data ?? "{}") as Record<string, unknown>)
  }
  return events
}

function toStream(
  chunks: Array<ChatCompletionChunk>,
): AsyncIterable<{ data?: string }> {
  // Sync generator is sufficient (no upstream I/O); `for await` accepts it.
  return (function* () {
    for (const chunk of chunks) yield { data: JSON.stringify(chunk) }
  })() as unknown as AsyncIterable<{ data?: string }>
}

describe("chat → responses streaming reasoning", () => {
  test("picks up delta.reasoning_content (DeepSeek/Kimi/xAI style)", async () => {
    const chunk: ChatCompletionChunk = {
      id: "cmpl-1",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-5",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: "thinking step" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events = await collectStreamEvents(
      translateChatCompletionsStreamToResponses(toStream([chunk]), {
        model: "gpt-5",
        input: "hi",
      }),
    )

    const reasoningEvents = events.filter(
      (e) => e.type === "response.reasoning_summary_text.delta",
    )
    expect(reasoningEvents).toHaveLength(1)
    expect(reasoningEvents[0]).toMatchObject({ delta: "thinking step" })
  })

  test("emits no reasoning event when only content is present", async () => {
    const chunk: ChatCompletionChunk = {
      id: "cmpl-2",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "gpt-5",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "plain" },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }

    const events = await collectStreamEvents(
      translateChatCompletionsStreamToResponses(toStream([chunk]), {
        model: "gpt-5",
        input: "hi",
      }),
    )

    expect(
      events.some((e) => e.type === "response.reasoning_summary_text.delta"),
    ).toBe(false)
  })
})
