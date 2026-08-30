import { describe, expect, test } from "bun:test"

import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

import { pumpWithLeadingBuffer, sendText } from "~/routes/responses/ws-pump"
import { collectResponsesFromEventStream } from "~/services/responses/sse-collector"

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
  test("keeps empty lifecycle frames retryable when the upstream drops", async () => {
    const sent: Array<string> = []
    let commits = 0
    const events: Array<CopilotStreamEventLike> = [
      {
        data: JSON.stringify({
          type: "response.created",
          response: { id: "resp_dropped", status: "in_progress" },
        }),
      },
      {
        data: JSON.stringify({
          type: "response.output_item.added",
          item: { type: "reasoning", summary: [] },
        }),
      },
      {
        data: JSON.stringify({
          type: "response.reasoning_summary_part.added",
          part: { type: "summary_text", text: "" },
        }),
      },
    ]
    const droppedStream: AsyncIterable<CopilotStreamEventLike> = {
      [Symbol.asyncIterator]() {
        const iterator = events[Symbol.iterator]()
        return {
          next() {
            const next = iterator.next()
            return next.done ?
                Promise.reject(
                  new Error(
                    "codex websockets: upstream socket closed unexpectedly",
                  ),
                )
              : Promise.resolve(next)
          },
        }
      },
    }

    let caught: unknown
    try {
      await pumpWithLeadingBuffer(
        {
          readyState: 1,
          send(data) {
            sent.push(
              typeof data === "string" ? data : new TextDecoder().decode(data),
            )
          },
        },
        droppedStream,
        {
          onCommit() {
            commits += 1
          },
        },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain(
      "upstream socket closed unexpectedly",
    )
    expect(sent).toEqual([])
    expect(commits).toBe(0)
  })

  test("keeps a 64-frame control burst retryable under the byte cap", async () => {
    const events = Array.from({ length: 64 }, (_, sequence) => ({
      data: JSON.stringify({
        type: "response.output_item.added",
        sequence,
        item: { type: "reasoning", summary: [] },
      }),
    }))
    const droppedStream: AsyncIterable<CopilotStreamEventLike> = {
      [Symbol.asyncIterator]() {
        const iterator = events[Symbol.iterator]()
        return {
          next() {
            const next = iterator.next()
            return next.done ?
                Promise.reject(new Error("upstream socket dropped"))
              : Promise.resolve(next)
          },
        }
      },
    }
    let commits = 0
    let caught: unknown

    try {
      await pumpWithLeadingBuffer({ readyState: 1, send() {} }, droppedStream, {
        onCommit() {
          commits += 1
        },
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe("upstream socket dropped")
    expect(commits).toBe(0)
  })

  test("reports why the bounded control-frame buffer commits", async () => {
    const details: Array<{
      reason: string
      bufferedEvents: number
      bufferedBytes: number
    }> = []
    const events = Array.from({ length: 128 }, (_, sequence) => ({
      data: JSON.stringify({
        type: "response.output_item.added",
        sequence,
        item: { type: "reasoning", summary: [] },
      }),
    }))
    let caught: unknown

    try {
      await pumpWithLeadingBuffer(
        { readyState: 1, send() {} },
        eventStream(events),
        {
          onCommit(commit) {
            details.push(commit)
          },
        },
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain("terminal response event")
    expect(details).toHaveLength(1)
    expect(details[0]?.reason).toBe("buffer_message_limit")
    expect(details[0]?.bufferedEvents).toBe(128)
    expect(details[0]?.bufferedBytes).toBeGreaterThan(0)
  })

  test("does not treat an empty output container as first content", async () => {
    const result = await pumpWithLeadingBuffer(
      { readyState: 1, send() {} },
      eventStream([
        {
          data: JSON.stringify({
            type: "response.output_item.added",
            item: { type: "message", role: "assistant", content: [] },
          }),
        },
        {
          data: JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_empty",
              object: "response",
              model: "gpt-5",
              status: "completed",
              output: [],
            },
          }),
        },
      ]),
      { onCommit() {} },
    )

    expect(result.outputObserved).toBe(false)
    expect(result.firstContentAt).toBeUndefined()
  })

  test("uses terminal output as the first-observed-content fallback", async () => {
    const result = await pumpWithLeadingBuffer(
      { readyState: 1, send() {} },
      eventStream([
        {
          data: JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_terminal_output",
              object: "response",
              model: "gpt-5",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "done" }],
                },
              ],
            },
          }),
        },
      ]),
      { onCommit() {} },
    )

    expect(result.outputObserved).toBe(true)
    expect(result.firstContentAt).toBeNumber()
  })

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

  test("collects response.incomplete for non-streaming WS clients", async () => {
    const response = await collectResponsesFromEventStream(
      eventStream([
        {
          data: JSON.stringify({
            type: "response.incomplete",
            response: {
              id: "resp_incomplete",
              object: "response",
              status: "incomplete",
              output: [],
            },
          }),
        },
        { data: "[DONE]" },
      ]),
      "gpt-5",
    )

    expect(response.id).toBe("resp_incomplete")
    expect(response.status).toBe("incomplete")
    expect(response.model).toBe("gpt-5")
  })

  test("does not send after the request signal is aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    let sent = 0

    const accepted = await sendText(
      {
        readyState: 1,
        send() {
          sent += 1
          return 1
        },
      },
      "late frame",
      controller.signal,
    )

    expect(accepted).toBe(false)
    expect(sent).toBe(0)
  })
})
