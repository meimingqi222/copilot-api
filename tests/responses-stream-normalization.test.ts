import { describe, expect, test } from "bun:test"

import {
  normalizeResponsesStreamIds,
  type CopilotStreamEventLike,
} from "~/services/copilot/responses-api"

async function collectEvents(
  response: AsyncIterable<CopilotStreamEventLike>,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  for await (const event of response) {
    if (!event.data || event.data === "[DONE]") {
      continue
    }
    events.push(JSON.parse(event.data) as Record<string, unknown>)
  }
  return events
}

async function* toAsyncIterable(
  events: Array<Record<string, unknown>>,
): AsyncIterable<CopilotStreamEventLike> {
  for (const event of events) {
    await Promise.resolve()
    yield { data: JSON.stringify(event) }
  }
}

describe("normalizeResponsesStreamIds", () => {
  test("keeps response and output item ids stable across a streamed reasoning response", async () => {
    const events = await collectEvents(
      normalizeResponsesStreamIds(
        toAsyncIterable([
          {
            type: "response.created",
            response: {
              id: "resp_created",
              output: [],
            },
          },
          {
            type: "response.in_progress",
            response: {
              id: "resp_progress",
              output: [],
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "reasoning_added",
              type: "reasoning",
              summary: [],
            },
          },
          {
            type: "response.reasoning_summary_part.added",
            output_index: 0,
            item_id: "reasoning_part",
            summary_index: 0,
            part: {
              type: "summary_text",
              text: "",
            },
          },
          {
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            item_id: "reasoning_delta_1",
            summary_index: 0,
            delta: "Thinking",
          },
          {
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            item_id: "reasoning_delta_2",
            summary_index: 0,
            delta: " more",
          },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: {
              id: "message_added",
              type: "message",
              role: "assistant",
              content: [],
            },
          },
          {
            type: "response.output_text.delta",
            output_index: 1,
            item_id: "message_delta",
            content_index: 0,
            delta: "76488",
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "reasoning_done",
              type: "reasoning",
            },
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              id: "message_done",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "76488",
                },
              ],
            },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_completed",
              output: [
                {
                  id: "reasoning_completed",
                  type: "reasoning",
                  summary: [{ type: "summary_text", text: "Thinking more" }],
                },
                {
                  id: "message_completed",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "76488" }],
                },
              ],
            },
          },
        ]),
      ),
    )

    const created = events[0] as {
      response: { id: string }
    }
    const reasoningAdded = events[2] as {
      item: { id: string }
    }
    const messageAdded = events[6] as {
      item: { id: string }
    }
    const completed = events.at(-1) as {
      response: { id: string; output: Array<{ id: string }> }
    }

    expect(created.response.id).toBe("resp_created")
    expect((events[1] as { response: { id: string } }).response.id).toBe(
      "resp_created",
    )
    expect((events[3] as { item_id: string }).item_id).toBe(
      reasoningAdded.item.id,
    )
    expect((events[4] as { item_id: string }).item_id).toBe(
      reasoningAdded.item.id,
    )
    expect((events[5] as { item_id: string }).item_id).toBe(
      reasoningAdded.item.id,
    )
    expect((events[7] as { item_id: string }).item_id).toBe(
      messageAdded.item.id,
    )
    expect((events[8] as { item: { id: string } }).item.id).toBe(
      reasoningAdded.item.id,
    )
    expect((events[9] as { item: { id: string } }).item.id).toBe(
      messageAdded.item.id,
    )
    expect(completed.response.id).toBe("resp_created")
    expect(completed.response.output[0]?.id).toBe(reasoningAdded.item.id)
    expect(completed.response.output[1]?.id).toBe(messageAdded.item.id)
  })
})
