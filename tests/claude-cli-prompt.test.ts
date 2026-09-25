import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"

import {
  renderClaudePrompt,
  type ClaudePromptBlock,
} from "~/services/claude/cli/prompt"

function payload(
  messages: AnthropicMessagesPayload["messages"],
  extra: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return { model: "claude-sonnet-4-6", max_tokens: 1024, messages, ...extra }
}

/** All text of the rendered blocks, concatenated. */
function textOf(blocks: Array<ClaudePromptBlock>): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
}

describe("renderClaudePrompt", () => {
  test("labels turns as Human / Assistant", () => {
    const blocks = renderClaudePrompt(
      payload([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ]),
    )
    expect(textOf(blocks)).toBe("Human: hello\n\nAssistant: hi there\n\n")
  })

  test("wraps the caller's system prompt in user content, not the system field", () => {
    const blocks = renderClaudePrompt(
      payload([{ role: "user", content: "hi" }], { system: "BE TERSE" }),
    )
    const text = textOf(blocks)
    expect(text).toContain("<external_system_instructions>\nBE TERSE\n")
    expect(text).toContain("</external_system_instructions>")
  })

  test("joins an array system prompt", () => {
    const blocks = renderClaudePrompt(
      payload([{ role: "user", content: "hi" }], {
        system: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    )
    expect(textOf(blocks)).toContain("one\ntwo")
  })

  test("states a forced tool choice in the system note", () => {
    const any = renderClaudePrompt(
      payload([{ role: "user", content: "hi" }], {
        tool_choice: { type: "any" },
      }),
    )
    expect(textOf(any)).toContain("You must call at least one available tool")

    const named = renderClaudePrompt(
      payload([{ role: "user", content: "hi" }], {
        tool_choice: { type: "tool", name: "search" },
      }),
    )
    expect(textOf(named)).toContain("You must call the search tool.")
  })

  test("omits the system block when there is nothing to say", () => {
    const blocks = renderClaudePrompt(
      payload([{ role: "user", content: "hi" }]),
    )
    expect(textOf(blocks)).not.toContain("<external_system_instructions>")
  })

  test("renders tool calls and results in the text form", () => {
    const blocks = renderClaudePrompt(
      payload([
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "get_weather",
              input: { city: "SF" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "sunny",
            },
          ],
        },
      ]),
    )
    const text = textOf(blocks)
    expect(text).toContain(
      `[tool call get_weather id=toolu_1 args={"city":"SF"}]`,
    )
    expect(text).toContain("[tool result id=toolu_1]\nsunny")
  })

  test("marks a failed tool result", () => {
    const blocks = renderClaudePrompt(
      payload([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_9",
              content: "boom",
              is_error: true,
            },
          ],
        },
      ]),
    )
    expect(textOf(blocks)).toContain("[tool result id=toolu_9 error]\nboom")
  })

  test("renders historical thinking as plain text", () => {
    const blocks = renderClaudePrompt(
      payload([
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "let me think" }],
        },
      ]),
    )
    expect(textOf(blocks)).toContain("let me think")
  })

  test("hoists images into their own blocks, in order", () => {
    const blocks = renderClaudePrompt(
      payload([
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAA" },
            },
            { type: "text", text: "after" },
          ],
        },
      ]),
    )
    // The image splits the turn into two text blocks; the model sees them as
    // separate blocks with the image in between, which is what we want.
    expect(blocks.map((block) => block.type)).toEqual(["text", "image", "text"])
    expect(blocks[0]).toEqual({ type: "text", text: "Human: before" })
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAA" },
    })
    expect(blocks[2]).toEqual({ type: "text", text: "after\n\n" })
  })

  test("hoists an image inside a tool result", () => {
    const blocks = renderClaudePrompt(
      payload([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: [
                { type: "text", text: "screenshot:" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "BBB",
                  },
                },
              ],
            },
          ],
        },
      ]),
    )
    expect(blocks.map((block) => block.type)).toEqual(["text", "image", "text"])
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "BBB" },
    })
  })

  test("falls back to a continue marker for an empty conversation", () => {
    const blocks = renderClaudePrompt(payload([]))
    expect(blocks).toEqual([{ type: "text", text: "[continue]" }])
  })

  test("keeps a URL image source intact", () => {
    const blocks = renderClaudePrompt(
      payload([
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "url", url: "https://example.com/a.png" },
            },
          ],
        },
      ]),
    )
    const image = blocks.find((block) => block.type === "image")
    expect(image).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/a.png" },
    })
  })
})

/**
 * Prefix stability is what makes the cross-turn prompt cache work: the renderer
 * must be a pure sequential concatenation with no header/footer that depends on
 * the message count. See docs/todo-claude-cli-transport.md §6.1.
 */
describe("renderClaudePrompt prefix stability", () => {
  const conversation: AnthropicMessagesPayload["messages"] = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_a",
          name: "read",
          input: { path: "/x" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_a", content: "file body" },
      ],
    },
    { role: "user", content: "second question" },
  ]

  test("each longer transcript starts with the shorter one", () => {
    for (let n = 1; n < conversation.length; n += 1) {
      const shorter = textOf(
        renderClaudePrompt(
          payload(conversation.slice(0, n), { system: "BE TERSE" }),
        ),
      )
      const longer = textOf(
        renderClaudePrompt(
          payload(conversation.slice(0, n + 1), { system: "BE TERSE" }),
        ),
      )
      expect(longer.startsWith(shorter)).toBe(true)
    }
  })

  test("re-rendering the same transcript is byte-identical", () => {
    const once = textOf(renderClaudePrompt(payload(conversation)))
    const twice = textOf(renderClaudePrompt(payload(conversation)))
    expect(twice).toBe(once)
  })
})
