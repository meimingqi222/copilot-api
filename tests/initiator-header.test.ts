import { describe, expect, test } from "bun:test"

import {
  inferInitiatorFromAnthropicPayload,
  inferInitiatorFromChatMessages,
  inferInitiatorFromResponsesPayload,
  resolveInitiatorFromHeader,
} from "~/lib/initiator-header"

describe("resolveInitiatorFromHeader", () => {
  test("client=agent 时信任并覆盖 inferred=user", () => {
    expect(resolveInitiatorFromHeader("agent", "user")).toEqual({
      initiator: "agent",
      trustedClientAgent: true,
    })
  })

  test("client=user 时仍回退推断结果", () => {
    expect(resolveInitiatorFromHeader("user", "agent")).toEqual({
      initiator: "agent",
      trustedClientAgent: false,
    })
  })

  test("无 header 时使用 inferred 结果", () => {
    expect(resolveInitiatorFromHeader(undefined, "user")).toEqual({
      initiator: "user",
      trustedClientAgent: false,
    })
  })
})

describe("initiator inference", () => {
  test("infers chat initiator from the latest conversation message", () => {
    expect(
      inferInitiatorFromChatMessages([
        { role: "system" },
        { role: "user" },
        { role: "assistant" },
      ]),
    ).toBe("agent")
    expect(
      inferInitiatorFromChatMessages([
        { role: "developer" },
        { role: "assistant" },
        { role: "user" },
      ]),
    ).toBe("user")
  })

  test("infers anthropic initiator from assistant and tool_result turns", () => {
    expect(
      inferInitiatorFromAnthropicPayload({
        messages: [{ role: "assistant", content: "done" }],
      }),
    ).toBe("agent")
    expect(
      inferInitiatorFromAnthropicPayload({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
            ],
          },
        ],
      }),
    ).toBe("agent")
    expect(
      inferInitiatorFromAnthropicPayload({
        messages: [{ role: "user", content: "hello" }],
      }),
    ).toBe("user")
  })

  test("infers responses initiator from the last input item", () => {
    expect(inferInitiatorFromResponsesPayload({ input: "hi" })).toBe("user")
    expect(
      inferInitiatorFromResponsesPayload({
        input: [{ role: "assistant", content: "thinking" }],
      }),
    ).toBe("agent")
    expect(
      inferInitiatorFromResponsesPayload({
        input: [
          {
            type: "function_call",
            call_id: "c1",
            name: "tool",
            arguments: "{}",
          },
        ],
      }),
    ).toBe("agent")
  })
})
