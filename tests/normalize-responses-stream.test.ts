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

  test("appends output_item.done items missing from a partial completed output", async () => {
    const events = await collect([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "rs_1", type: "reasoning", summary: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          output: [{ id: "rs_1", type: "reasoning", summary: [] }],
        },
      },
    ])

    const completed = events[2]?.response as { output?: Array<unknown> }
    expect(completed.output).toEqual([
      { id: "rs_1", type: "reasoning", summary: [] },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    ])
  })

  test("hydrates response.incomplete output from observed done items", async () => {
    const events = await collect([
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg_1", content: [] },
      },
      {
        type: "response.incomplete",
        response: {
          id: "resp_1",
          object: "response",
          model: "gpt-5",
          status: "incomplete",
          output: [],
        },
      },
    ])

    const incomplete = events[1]?.response as { output?: Array<unknown> }
    expect(incomplete.output).toEqual([
      { type: "message", id: "msg_1", content: [] },
    ])
  })
})
