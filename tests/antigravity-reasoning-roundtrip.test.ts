import { describe, expect, test } from "bun:test"

import type { Message } from "~/services/copilot/create-chat-completions"

import { translateOpenAiChatToAntigravity } from "~/services/antigravity/translate-request"
import { convertAntigravityNonStreamResponse } from "~/services/antigravity/translate-response"

/** Parts of the model turn a replayed assistant message produces upstream. */
function replayModelParts(assistant: Message) {
  const turn = translateOpenAiChatToAntigravity(
    {
      model: "gemini-3-pro",
      messages: [
        { role: "user", content: "hi" },
        assistant,
        { role: "user", content: "continue" },
      ],
    },
    "test-project",
  ).request.contents.find((content) => content.role === "model")
  return turn?.parts ?? []
}

/** The thinking text Gemini receives, or undefined when it was dropped. */
function thoughtText(assistant: Message): string | undefined {
  return replayModelParts(assistant).find((part) => part.thought === true)?.text
}

describe("Antigravity reasoning round-trip", () => {
  test("replays the thought part from its own reply", () => {
    // Antigravity emits reasoning as `reasoning_content`; reading only
    // `reasoning_text` on the way back dropped the thought part entirely,
    // silently breaking chain-of-thought on every multi-turn conversation.
    const assistant = convertAntigravityNonStreamResponse(
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: "let me think",
                  thought: true,
                  thoughtSignature: "sig-abc",
                },
                { text: "the answer" },
              ],
            },
            finishReason: "STOP",
          },
        ],
        modelVersion: "gemini-3-pro",
      },
      "gemini-3-pro",
    ).choices[0].message

    expect(assistant.reasoning_content).toBe("let me think")

    expect(thoughtText(assistant as Message)).toBe("let me think")
    expect(replayModelParts(assistant as Message)).toContainEqual({
      text: "the answer",
    })
  })

  test("replays reasoning carried as content parts", () => {
    // The shape our translators emit whenever reasoning interleaves with text.
    expect(
      thoughtText({
        role: "assistant",
        content: [
          { type: "reasoning", text: "let me think" },
          { type: "text", text: "the answer" },
        ],
      }),
    ).toBe("let me think")
  })

  test("does not treat visible content as thinking text", () => {
    expect(
      replayModelParts({ role: "assistant", content: "just an answer" }),
    ).toEqual([{ text: "just an answer" }])
  })
})
