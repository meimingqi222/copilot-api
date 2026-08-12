import { describe, expect, test } from "bun:test"

import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

import { pumpWithLeadingBuffer } from "~/routes/responses/ws-pump"

function eventStream(
  events: Array<CopilotStreamEventLike>,
): AsyncIterable<CopilotStreamEventLike> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = events[Symbol.iterator]()
      return { next: () => Promise.resolve(iterator.next()) }
    },
  }
}

describe("Responses WebSocket pump", () => {
  test("returns response.incomplete for usage accounting", async () => {
    const sent: Array<string> = []
    const incompleteResponse = {
      id: "resp_incomplete",
      object: "response" as const,
      model: "gpt-5",
      status: "incomplete" as const,
      output: [],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
      },
    }
    const result = await pumpWithLeadingBuffer(
      {
        readyState: 1,
        send(data) {
          sent.push(
            typeof data === "string" ? data : new TextDecoder().decode(data),
          )
        },
      },
      eventStream([
        {
          data: JSON.stringify({
            type: "response.incomplete",
            response: incompleteResponse,
          }),
        },
        { data: "[DONE]" },
      ]),
      { onCommit() {} },
    )

    expect(result.terminal).toBe("response.incomplete")
    expect(result.completedResponse).toEqual(incompleteResponse)
    expect(result.completedResponse?.usage?.output_tokens).toBe(4)
    expect(sent).toHaveLength(1)
  })
})
