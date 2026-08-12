import { describe, expect, test } from "bun:test"

import {
  isValidGPTReasoningSignature,
  sanitizeCodexInput,
} from "~/services/codex/sanitize-input"

function validSignature(): string {
  const bytes = Buffer.alloc(73)
  bytes[0] = 0x80
  return bytes.toString("base64url")
}

describe("sanitizeCodexInput", () => {
  test("drops invalid encrypted_content and its orphan id with store=false", () => {
    const body = sanitizeCodexInput({
      store: false,
      input: [
        {
          type: "reasoning",
          id: "rs_stale",
          encrypted_content: "not-a-signature",
          summary: [],
        },
      ],
    })
    expect(body.input).toEqual([{ type: "reasoning", summary: [] }])
  })

  test("preserves a valid GPT reasoning signature", () => {
    const signature = validSignature()
    expect(signature.startsWith("gAAAA")).toBe(true)
    expect(isValidGPTReasoningSignature(signature)).toBe(true)
    const body = sanitizeCodexInput({
      store: false,
      input: [
        {
          type: "reasoning",
          id: "rs_valid",
          encrypted_content: signature,
        },
      ],
    })
    expect(body.input).toEqual([
      {
        type: "reasoning",
        id: "rs_valid",
        encrypted_content: signature,
      },
    ])
  })

  test("drops overlong encrypted reasoning items", () => {
    const body = sanitizeCodexInput({
      store: false,
      input: [
        {
          type: "reasoning",
          id: `rs_${"x".repeat(80)}`,
          encrypted_content: validSignature(),
        },
        { type: "message", role: "user", content: "keep" },
      ],
    })
    expect(body.input).toEqual([
      { type: "message", role: "user", content: "keep" },
    ])
  })

  test("normalizes and deterministically shortens other overlong ids", () => {
    const input = [
      {
        type: "message",
        id: "x".repeat(80),
        role: "assistant",
        content: [],
      },
    ]
    const first = sanitizeCodexInput({ store: false, input })
    const second = sanitizeCodexInput({ store: false, input })
    const firstId = (first.input as Array<{ id: string }>)[0]?.id
    expect(firstId).toHaveLength(64)
    expect(firstId.startsWith("msg_")).toBe(true)
    expect(second).toEqual(first)
  })
})
