import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { injectReasoningReplayItems } from "~/lib/cache/reasoning-replay-cache"

function replayItem(value: Record<string, unknown>) {
  return {
    type: value.type as "reasoning" | "function_call" | "custom_tool_call",
    raw: JSON.stringify(value),
  }
}

describe("injectReasoningReplayItems", () => {
  test("does not inject a dangling cached tool call", () => {
    const body = { input: [{ type: "message", role: "user", content: "next" }] }
    injectReasoningReplayItems(body, [
      replayItem({
        type: "custom_tool_call",
        call_id: "call_1",
        name: "shell",
        input: "pwd",
      }),
    ])
    expect(body.input).toHaveLength(1)
  })

  test("injects a cached call immediately before its matching output", () => {
    const output = {
      type: "custom_tool_call_output",
      call_id: "call_1",
      output: "ok",
    }
    const body: Record<string, unknown> = {
      input: [{ type: "message", role: "developer", content: "rules" }, output],
    }
    injectReasoningReplayItems(body, [
      replayItem({
        type: "custom_tool_call",
        call_id: "call_1",
        name: "shell",
        input: "pwd",
      }),
    ])
    expect(body.input).toEqual([
      { type: "message", role: "developer", content: "rules" },
      {
        type: "custom_tool_call",
        call_id: "call_1",
        name: "shell",
        input: "pwd",
      },
      output,
    ])
  })

  test("does not match a cached custom call to a function output", () => {
    const output = {
      type: "function_call_output",
      call_id: "call_1",
      output: "ok",
    }
    const body: Record<string, unknown> = { input: [output] }

    injectReasoningReplayItems(body, [
      replayItem({
        type: "custom_tool_call",
        call_id: "call_1",
        name: "shell",
        input: "pwd",
      }),
    ])

    expect(body.input).toEqual([output])
  })

  test("aligns cached call_id to the client-visible shortened output id", () => {
    const original = `call_${"a".repeat(90)}`
    const sanitized = original.replaceAll(/[^\w-]/g, "_")
    const suffix = `_${createHash("sha256").update(sanitized).digest("hex").slice(0, 16)}`
    const visible = `${sanitized.slice(0, 64 - suffix.length)}${suffix}`
    const body: Record<string, unknown> = {
      input: [
        {
          type: "function_call_output",
          call_id: visible,
          output: "ok",
        },
      ],
    }
    injectReasoningReplayItems(body, [
      replayItem({
        type: "function_call",
        call_id: original,
        name: "lookup",
        arguments: "{}",
      }),
    ])
    const input = body.input as Array<Record<string, unknown>>
    expect(input).toHaveLength(2)
    expect(input[0]?.type).toBe("function_call")
    expect(input[0]?.call_id).toBe(visible)
  })

  test("does not add cached reasoning when input already has reasoning", () => {
    const bytes = Buffer.alloc(73)
    bytes[0] = 0x80
    const existing = {
      type: "reasoning",
      encrypted_content: bytes.toString("base64url"),
    }
    const body: Record<string, unknown> = { input: [existing] }
    injectReasoningReplayItems(body, [
      replayItem({ type: "reasoning", encrypted_content: "gAAAA-cached" }),
    ])
    expect(body.input).toEqual([existing])
  })

  test("replaces invalid input reasoning with valid cached replay", () => {
    const bytes = Buffer.alloc(73)
    bytes[0] = 0x80
    const cached = bytes.toString("base64url")
    const body: Record<string, unknown> = {
      input: [{ type: "reasoning", encrypted_content: "invalid" }],
    }
    injectReasoningReplayItems(body, [
      replayItem({ type: "reasoning", encrypted_content: cached }),
    ])
    expect(body.input).toEqual([
      { type: "reasoning", encrypted_content: cached },
      { type: "reasoning", encrypted_content: "invalid" },
    ])
  })
})
