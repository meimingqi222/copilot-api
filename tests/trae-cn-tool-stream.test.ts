import { expect, test } from "bun:test"

import {
  traeCnCollect,
  traeCnParts,
  traeCnSse,
  traeCnStreamEvents,
  type TraeChatCall,
} from "~/services/trae-cn/client"

function upstream(events: Array<Record<string, unknown>>) {
  const text =
    events
      .map((event) => `event: output\ndata: ${JSON.stringify(event)}\n\n`)
      .join("") + "event: done\ndata: {}\n\n"
  return traeCnParts(traeCnSse(new Response(text).body!))
}

const fragments = [
  {
    tool_calls: [
      {
        index: 0,
        id: "call-a",
        function: { name: "read_file", arguments: '{"path":' },
      },
    ],
  },
  { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] },
]

test("Doubao sends the tool name before its arguments in an unnamed continuation", async () => {
  const parts = upstream([
    {
      tool_calls: [
        {
          index: 0,
          id: "doubao-call",
          function: { name: "diagnostic_echo", arguments: "" },
        },
      ],
    },
    {
      tool_calls: [
        {
          index: 0,
          id: "",
          function: { name: "", arguments: '{"message":"hello"}' },
        },
      ],
    },
  ])
  const calls: Array<TraeChatCall> = []
  for await (const part of parts) if ("call" in part) calls.push(part.call)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.id).toBe("doubao-call")
  expect(calls[0]!.name).toBe("diagnostic_echo")
  expect(JSON.parse(calls[0]!.arguments)).toEqual({ message: "hello" })
})

test("Trae native argument fragments become one complete call in both client modes", async () => {
  const calls: Array<TraeChatCall> = []
  for await (const part of upstream(fragments))
    if ("call" in part) calls.push(part.call)
  expect(
    calls.map((call) => [call.id, call.name, JSON.parse(call.arguments)]),
  ).toEqual([["call-a", "read_file", { path: "a.txt" }]])
  const response = await traeCnCollect(upstream(fragments), "glm-5.2")
  const choices = response.choices as Array<{
    message: { tool_calls: Array<{ function: { arguments: string } }> }
    finish_reason: string
  }>
  expect(choices[0]!.finish_reason).toBe("tool_calls")
  expect(
    JSON.parse(choices[0]!.message.tool_calls[0]!.function.arguments),
  ).toEqual({ path: "a.txt" })
  const streamed: Array<Record<string, unknown>> = []
  for await (const event of traeCnStreamEvents(
    upstream(fragments),
    "glm-5.2",
  )) {
    if (event.data !== "[DONE]")
      streamed.push(JSON.parse(event.data) as Record<string, unknown>)
  }
  const deltas = streamed.flatMap((chunk) =>
    (
      (chunk.choices as Array<{
        delta: { tool_calls?: Array<{ function: { arguments: string } }> }
      }>) ?? []
    ).flatMap((choice) => choice.delta.tool_calls ?? []),
  )
  expect(deltas).toHaveLength(1)
  expect(JSON.parse(deltas[0]!.function.arguments)).toEqual({ path: "a.txt" })
})

test("parallel tool fragments retain identity and cumulative snapshots replace partial arguments", async () => {
  const events = [
    {
      tool_calls: [
        {
          index: 0,
          id: "a",
          function: { name: "read", arguments: '{"path":' },
        },
        {
          index: 1,
          id: "b",
          function: { name: "search", arguments: '{"query":"' },
        },
      ],
    },
    { tool_calls: [{ index: 1, function: { arguments: 'hello"}' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '{"path":"file"}' } }] },
    {
      tool_calls: [
        {
          index: 0,
          id: "a",
          function: { name: "read", arguments: '{"path":"file"}' },
        },
      ],
    },
  ]
  const calls: Array<TraeChatCall> = []
  for await (const part of upstream(events))
    if ("call" in part) calls.push(part.call)
  expect(
    calls.map((call) => [call.id, call.name, JSON.parse(call.arguments)]),
  ).toEqual([
    ["a", "read", { path: "file" }],
    ["b", "search", { query: "hello" }],
  ])
})
