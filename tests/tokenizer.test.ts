import { describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { getTokenCount } from "~/lib/tokenizer"

const MODEL = {
  id: "swe-1",
  capabilities: { tokenizer: "o200k_base" },
} as Model

describe("token estimation", () => {
  test("estimates text from UTF-8 bytes and tracks assistant history", async () => {
    const result = await getTokenCount(
      {
        model: MODEL.id,
        messages: [
          { role: "user", content: "abcd" },
          { role: "assistant", content: "你好" },
        ],
      },
      MODEL,
    )

    // user: 3 overhead + 1 role + 1 content
    // assistant: 3 overhead + 3 role + 2 content (6 UTF-8 bytes)
    // reply priming: 3
    expect(result).toEqual({ input: 16, history: 8 })
  })

  test("handles a one-megabyte message with bounded byte estimation", async () => {
    const text = "abcd".repeat(256 * 1024)

    const result = await getTokenCount(
      {
        model: MODEL.id,
        messages: [{ role: "user", content: text }],
      },
      MODEL,
    )

    expect(result).toEqual({
      input: 256 * 1024 + 7,
      history: 0,
    })
  })

  test("uses a fixed allowance for inline base64 images", async () => {
    const result = await getTokenCount(
      {
        model: MODEL.id,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${"A".repeat(1024 * 1024)}`,
                },
              },
            ],
          },
        ],
      },
      MODEL,
    )

    expect(result).toEqual({ input: 92, history: 0 })
  })
})
