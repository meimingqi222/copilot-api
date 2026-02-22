import { describe, expect, test } from "bun:test"

import type { Message } from "~/services/copilot/create-chat-completions"

import { inferInitiatorFromOpenAIMessages } from "~/routes/chat-completions/initiator"

describe("inferInitiatorFromOpenAIMessages", () => {
  test("returns user for plain user message", () => {
    const messages: Array<Message> = [{ role: "user", content: "hello" }]
    expect(inferInitiatorFromOpenAIMessages(messages)).toBe("user")
  })

  test("returns agent when last message is assistant", () => {
    const messages: Array<Message> = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]
    expect(inferInitiatorFromOpenAIMessages(messages)).toBe("agent")
  })

  test("returns agent when last message is tool", () => {
    const messages: Array<Message> = [
      { role: "assistant", content: null },
      { role: "tool", tool_call_id: "tool_1", content: "ok" },
    ]
    expect(inferInitiatorFromOpenAIMessages(messages)).toBe("agent")
  })

  test("returns agent for codex handoff summary prefix", () => {
    const messages: Array<Message> = [
      { role: "assistant", content: "working..." },
      {
        role: "user",
        content:
          "Another language model started to solve this problem and produced a summary of its thinking process.",
      },
    ]
    expect(inferInitiatorFromOpenAIMessages(messages)).toBe("agent")
  })

  test("returns agent for codex compaction prompt marker", () => {
    const messages: Array<Message> = [
      { role: "assistant", content: "working..." },
      {
        role: "user",
        content:
          "You are performing a CONTEXT CHECKPOINT COMPACTION. Summarize state for the next model.",
      },
    ]
    expect(inferInitiatorFromOpenAIMessages(messages)).toBe("agent")
  })

  test("returns user for regular follow-up without compaction markers", () => {
    const messages: Array<Message> = [
      { role: "assistant", content: "working..." },
      { role: "user", content: "continue and provide the final answer" },
    ]
    expect(inferInitiatorFromOpenAIMessages(messages)).toBe("user")
  })
})
