import { describe, expect, test } from "bun:test"

import { inferInitiatorFromAnthropicMessages } from "~/routes/messages/initiator"

describe("inferInitiatorFromAnthropicMessages", () => {
  test("returns user for plain user message", () => {
    expect(
      inferInitiatorFromAnthropicMessages([{ role: "user", content: "hello" }]),
    ).toBe("user")
  })

  test("returns agent when last message is assistant", () => {
    expect(
      inferInitiatorFromAnthropicMessages([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
    ).toBe("agent")
  })

  test("returns agent when last user message contains tool_result", () => {
    expect(
      inferInitiatorFromAnthropicMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "ok",
            },
          ],
        },
      ]),
    ).toBe("agent")
  })

  test("returns agent when previous assistant message is tool_use", () => {
    expect(
      inferInitiatorFromAnthropicMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "continue" }],
        },
      ]),
    ).toBe("agent")
  })

  test("returns agent for likely claude-code compaction prompts", () => {
    const longCompactionPrompt =
      "Please summarize the conversation and compress context window.\n\n"
      + "A".repeat(900)

    expect(
      inferInitiatorFromAnthropicMessages(
        [
          { role: "assistant", content: "previous answer" },
          { role: "user", content: longCompactionPrompt },
        ],
        "claude-code-20250124",
      ),
    ).toBe("agent")
  })

  test("keeps user for normal claude-code user prompts", () => {
    expect(
      inferInitiatorFromAnthropicMessages(
        [
          { role: "assistant", content: "previous answer" },
          { role: "user", content: "continue with the task" },
        ],
        "claude-code-20250124",
      ),
    ).toBe("user")
  })
})
