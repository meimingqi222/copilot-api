import { describe, expect, test } from "bun:test"

import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"

async function collect(events: Array<Record<string, unknown>>) {
  const stream = {
    async *[Symbol.asyncIterator](): AsyncIterableIterator<CopilotStreamEventLike> {
      await Promise.resolve()
      for (const event of events) yield { data: JSON.stringify(event) }
    },
  }
  const parsed: Array<Record<string, unknown>> = []
  for await (const event of normalizeResponsesStreamIds(stream)) {
    if (event.data)
      parsed.push(JSON.parse(event.data) as Record<string, unknown>)
  }
  return parsed
}

describe("normalizeResponsesStreamIds", () => {
  test("hydrates empty completed output from output_item.done events", async () => {
    const events = await collect([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "ctc_1",
          type: "custom_tool_call",
          call_id: "call_1",
          name: "shell",
          input: "pwd",
        },
      },
      {
        type: "response.completed",
        response: { id: "resp_1", output: [] },
      },
    ])
    const completed = events[1]?.response as { output?: Array<unknown> }
    expect(completed.output).toEqual([
      {
        id: "ctc_1",
        type: "custom_tool_call",
        call_id: "call_1",
        name: "shell",
        input: "pwd",
      },
    ])
  })

  test("hydrates a missing completed item id by output index", async () => {
    const events = await collect([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant" },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          output: [{ type: "message", role: "assistant" }],
        },
      },
    ])
    const completed = events[1]?.response as {
      output?: Array<Record<string, unknown>>
    }
    expect(completed.output?.[0]?.id).toBe("msg_1")
  })
})
