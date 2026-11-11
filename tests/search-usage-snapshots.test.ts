import { expect, test } from "bun:test"

import { decodeMessagesRequest } from "~/services/ir/codecs/messages-chat/request"
import { wireSpec } from "~/services/protocols/wire-pairs"
import {
  runSearchAwareResult,
  runSearchAwareStream,
} from "~/services/search/orchestrate"

test.each([false, true])(
  "search orchestration sums distinct rounds without summing duplicate snapshots (stream=%s)",
  async (stream) => {
    let round = 0
    async function* response() {
      round++
      if (round === 1) {
        yield {
          data: JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_search",
                      type: "function",
                      function: {
                        name: "web_search",
                        arguments: '{"query":"test"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
        }
      } else {
        for (const delta of [
          { reasoning_content: "plan" },
          { content: "answer" },
          { reasoning_content: "reconsider" },
          { content: "suffix" },
        ])
          yield {
            data: JSON.stringify({
              id: "round-two",
              model: "writer",
              choices: [{ delta, finish_reason: null }],
            }),
          }
      }
      const usage = {
        prompt_tokens: round * 10,
        completion_tokens: round + 1,
        total_tokens: round * 10 + round + 1,
      }
      for (let repeat = 0; repeat < 2; repeat++) {
        yield { data: JSON.stringify({ choices: [], usage }) }
      }
      yield { data: "[DONE]" }
    }
    const params = {
      request: decodeMessagesRequest({
        model: "writer",
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
      spec: wireSpec("chat"),
      searchers: [],
      execute: async () => ({ response: response(), credentialId: "cred" }),
    }
    if (!stream) {
      const { result } = await runSearchAwareResult(params)
      expect(round).toBe(2)
      expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 5 })
      expect(
        result.parts.filter(
          (part) => part.type === "thinking" || part.type === "text",
        ),
      ).toEqual([
        { type: "thinking", text: "plan", source: { wire: "chat" } },
        { type: "text", text: "answer" },
        { type: "thinking", text: "reconsider", source: { wire: "chat" } },
        { type: "text", text: "suffix" },
      ])
      return
    }
    const events = []
    for await (const event of runSearchAwareStream(params)) events.push(event)
    const usage = events.findLast((event) => event.type === "usage")
    expect(round).toBe(2)
    expect(usage?.type === "usage" && usage.usage.inputTokens).toBe(30)
    expect(usage?.type === "usage" && usage.usage.outputTokens).toBe(5)
  },
)

test("search orchestration merges cumulative usage snapshots within a round", async () => {
  async function* response() {
    for (const event of [
      {
        type: "message_start",
        message: {
          id: "msg",
          model: "writer",
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "message_delta", usage: { input_tokens: 10, output_tokens: 2 } },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      { type: "message_stop" },
    ])
      yield { data: JSON.stringify(event) }
  }
  const events = []
  for await (const event of runSearchAwareStream({
    request: decodeMessagesRequest({
      model: "writer",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    }),
    spec: wireSpec("messages"),
    searchers: [],
    execute: async () => ({ response: response(), credentialId: "cred" }),
  }))
    events.push(event)
  const usage = events.find((event) => event.type === "usage")
  expect(usage?.type === "usage" && usage.usage.inputTokens).toBe(10)
  expect(usage?.type === "usage" && usage.usage.outputTokens).toBe(5)
})
