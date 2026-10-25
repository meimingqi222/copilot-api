import { expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"

import { renderClaudePrompt } from "~/services/claude/cli/prompt"
import {
  bridgeToolNames,
  bridgeTools,
  declaredToolNames,
  toolResults,
} from "~/services/claude/cli/tools"
import {
  collectAnthropicResponse,
  translateClaudeStreamJson,
} from "~/services/claude/cli/translate"

const schema = { type: "object", properties: {} }

function payload(
  extra: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "go" }],
    tools: [
      { name: "spawn.agent", input_schema: schema },
      { name: "spawn_agent", input_schema: schema },
      { name: "read:file", input_schema: schema },
      { name: "wait_for_tool", input_schema: schema },
    ],
    ...extra,
  }
}

async function* lines(values: Array<unknown>) {
  for (const value of values) yield JSON.stringify(value)
}

test("names Claude Code would rewrite get a legal name of their own, unique and stable", () => {
  const names = bridgeToolNames(payload())
  expect([...names]).toEqual([
    ["spawn.agent", "spawn_agent"],
    // The legal name is taken now; and the bridge's own tool is reserved.
    ["spawn_agent", "spawn_agent_2"],
    ["read:file", "read_file"],
    ["wait_for_tool", "wait_for_tool_2"],
  ])
  expect(bridgeToolNames(payload())).toEqual(names)
  expect(bridgeTools(payload()).map((tool) => tool.name)).toEqual([
    "read_file",
    "spawn_agent",
    "spawn_agent_2",
    "wait_for_tool",
    "wait_for_tool_2",
  ])
})

test("a tool call comes back under the name the client declared", async () => {
  const response = await collectAnthropicResponse(
    translateClaudeStreamJson(
      lines([
        {
          type: "stream_event",
          event: { type: "message_start", message: { id: "m" } },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__copilotapi__spawn_agent",
            },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          },
        },
        {
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
        },
        {
          type: "stream_event",
          event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
        },
      ]),
      { model: "m", toolNames: declaredToolNames(payload()) },
    ),
    "m",
  )
  expect(response.content).toEqual([
    { type: "tool_use", id: "toolu_1", name: "spawn.agent", input: {} },
  ])
})

test("the prompt names tools as Claude Code lists them", () => {
  const blocks = renderClaudePrompt(
    payload({
      tool_choice: { type: "tool", name: "read:file" },
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_0", name: "spawn.agent", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_0", content: "ok" },
          ],
        },
      ],
    }),
  )
  const text = blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
  expect(text).toContain("You must call the read_file tool.")
  expect(text).toContain("[tool call spawn_agent id=toolu_0")
  expect(text).not.toContain("spawn.agent")
})

function resultsWith(
  content: Extract<
    AnthropicMessagesPayload["messages"][number],
    { role: "user" }
  >["content"],
  after: Array<AnthropicMessagesPayload["messages"][number]> = [],
) {
  return toolResults(
    payload({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-1", name: "spawn.agent", input: {} },
            { type: "tool_use", id: "call-2", name: "read:file", input: {} },
          ],
        },
        { role: "user", content },
        ...after,
      ],
    }),
  )
}

const NOTICE =
  "<task-notification><task-id>a1</task-id><result>SUBRESULT-A</result></task-notification>"

test("a background sub-agent's notification beside the results reaches the run", () => {
  for (const results of [
    // A text block of the results' message.
    resultsWith([
      { type: "tool_result", tool_use_id: "call-1", content: "slept" },
      { type: "tool_result", tool_use_id: "call-2", content: "read" },
      { type: "text", text: NOTICE },
    ]),
    // Its own message after the results, wrapped in a reminder.
    resultsWith(
      [
        { type: "tool_result", tool_use_id: "call-1", content: "slept" },
        { type: "tool_result", tool_use_id: "call-2", content: "read" },
      ],
      [
        {
          role: "user",
          content: `<system-reminder>${NOTICE}</system-reminder>`,
        },
      ],
    ),
  ]) {
    expect(results[0].content).toEqual([{ type: "text", text: "slept" }])
    const last = JSON.stringify(results[1].content)
    expect(last).toContain("SUBRESULT-A")
    expect(last).toContain("<system-reminder>")
    expect(last).not.toContain("The user sent")
  }
})

test("the user's mid-turn words go on as theirs; the client's own reminders do not", () => {
  const results = resultsWith([
    { type: "tool_result", tool_use_id: "call-1", content: "slept" },
    {
      type: "text",
      text: "<system-reminder>Token usage: 1234</system-reminder>also check the tests",
    },
  ])
  const text = JSON.stringify(results[0].content)
  expect(text).toContain("The user sent a new message while you were working")
  expect(text).toContain("also check the tests")
  expect(text).not.toContain("Token usage")
  // Nothing beside the results: they go as they came.
  expect(
    resultsWith([
      { type: "tool_result", tool_use_id: "call-1", content: "slept" },
    ])[0].content,
  ).toEqual([{ type: "text", text: "slept" }])
})
