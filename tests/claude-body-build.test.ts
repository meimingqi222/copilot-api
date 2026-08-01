import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic"

import {
  buildClaudeSystemForTest,
  buildOrderedBody,
} from "~/services/claude/create-messages-once"
import {
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  claudeCodeSystemInstruction,
} from "~/services/claude/fingerprint"

function basePayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4",
    messages: [{ role: "user", content: "Hello, world!" }],
    max_tokens: 128000,
    ...overrides,
  }
}

describe("buildClaudeSystemForTest", () => {
  test("injects billing header at system[0] and CC instruction at system[1]", () => {
    const system = buildClaudeSystemForTest(
      basePayload({ system: "my instructions" }),
    )
    expect(system).toHaveLength(3)
    expect(system[0].text).toMatch(/^x-anthropic-billing-header:/)
    expect(system[0].text).toContain("cch=00000")
    expect(system[1].text).toBe(claudeCodeSystemInstruction)
    expect(system[2].text).toBe("my instructions")
  })

  test("works with array system", () => {
    const system = buildClaudeSystemForTest(
      basePayload({ system: [{ type: "text", text: "block A" }] }),
    )
    expect(system[2].text).toBe("block A")
  })

  test("works with no caller system", () => {
    const system = buildClaudeSystemForTest(basePayload())
    expect(system).toHaveLength(2)
  })
})

describe("buildOrderedBody", () => {
  test("clamps max_tokens to CLAUDE_CODE_MAX_OUTPUT_TOKENS (64000)", () => {
    const body = buildOrderedBody(
      basePayload({ max_tokens: 128000 }),
      "claude-sonnet-4",
      buildClaudeSystemForTest(basePayload({ max_tokens: 128000 })),
      undefined,
    )
    expect(body.max_tokens).toBe(CLAUDE_CODE_MAX_OUTPUT_TOKENS)
  })

  test("keeps max_tokens when below the clamp", () => {
    const body = buildOrderedBody(
      basePayload({ max_tokens: 4096 }),
      "claude-sonnet-4",
      buildClaudeSystemForTest(basePayload({ max_tokens: 4096 })),
      undefined,
    )
    expect(body.max_tokens).toBe(4096)
  })

  test("includes an empty tools array for OAuth requests without tools", () => {
    const payload = basePayload()
    const body = buildOrderedBody(
      payload,
      "claude-sonnet-4",
      buildClaudeSystemForTest(payload),
      undefined,
    )
    expect(body.tools).toEqual([])
  })

  test("applies `_` tool-name prefix to non-builtin tools", () => {
    const payload = basePayload({
      tools: [
        { name: "read_file", input_schema: {} },
        { name: "web_search", input_schema: {} },
      ],
    })
    const body = buildOrderedBody(
      payload,
      "claude-sonnet-4",
      buildClaudeSystemForTest(payload),
      undefined,
    )
    const tools = body.tools as Array<{ name: string }>
    expect(tools[0].name).toBe("_read_file")
    expect(tools[1].name).toBe("web_search") // builtin not prefixed
  })

  test("adds context_management for enabled thinking", () => {
    const payload = basePayload({
      thinking: { type: "enabled", budget_tokens: 5000 },
    })
    const body = buildOrderedBody(
      payload,
      "claude-sonnet-4",
      buildClaudeSystemForTest(payload),
      undefined,
    )
    expect(body.context_management).toEqual({
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    })
  })

  test("adds context_management for adaptive thinking", () => {
    const payload = basePayload({ thinking: { type: "adaptive" } })
    const body = buildOrderedBody(
      payload,
      "claude-sonnet-4",
      buildClaudeSystemForTest(payload),
      undefined,
    )
    expect(body.context_management).toBeDefined()
  })

  test("omits context_management when thinking is disabled", () => {
    const payload = basePayload({ thinking: { type: "disabled" } })
    const body = buildOrderedBody(
      payload,
      "claude-sonnet-4",
      buildClaudeSystemForTest(payload),
      undefined,
    )
    expect(body.context_management).toBeUndefined()
  })

  test("omits context_management when no thinking", () => {
    const payload = basePayload()
    const body = buildOrderedBody(
      payload,
      "claude-sonnet-4",
      buildClaudeSystemForTest(payload),
      undefined,
    )
    expect(body.context_management).toBeUndefined()
  })

  test("places a 1h cache_control breakpoint on the last system block", () => {
    const payload = basePayload({ system: "my system" })
    const system = buildClaudeSystemForTest(payload)
    const body = buildOrderedBody(payload, "claude-sonnet-4", system, undefined)
    const sys = body.system as Array<{ cache_control?: unknown }>
    expect(sys[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(sys[0].cache_control).toBeUndefined()
    expect(sys[1].cache_control).toBeUndefined()
  })

  test("does not mutate caller messages while placing cache breakpoints", () => {
    const payload = basePayload({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            { type: "tool_result", tool_use_id: "tool-1", content: "hidden" },
          ],
        },
      ],
    })
    const before = structuredClone(payload.messages)
    buildOrderedBody(
      payload,
      "claude-sonnet-4",
      buildClaudeSystemForTest(payload),
      undefined,
    )
    expect(payload.messages).toEqual(before)
  })

  test("canonical field order: model, messages, system, tools, metadata, max_tokens, thinking, context_management, ...", () => {
    const payload = basePayload({
      tools: [{ name: "read_file", input_schema: {} }],
      thinking: { type: "enabled", budget_tokens: 5000 },
    })
    const body = buildOrderedBody(
      payload,
      "claude-sonnet-4",
      buildClaudeSystemForTest(payload),
      "user-id-x",
    )
    const keys = Object.keys(body)
    expect(keys.indexOf("model")).toBeLessThan(keys.indexOf("messages"))
    expect(keys.indexOf("messages")).toBeLessThan(keys.indexOf("system"))
    expect(keys.indexOf("system")).toBeLessThan(keys.indexOf("tools"))
    expect(keys.indexOf("tools")).toBeLessThan(keys.indexOf("metadata"))
    expect(keys.indexOf("metadata")).toBeLessThan(keys.indexOf("max_tokens"))
    expect(keys.indexOf("max_tokens")).toBeLessThan(keys.indexOf("thinking"))
    expect(keys.indexOf("thinking")).toBeLessThan(
      keys.indexOf("context_management"),
    )
    expect(body.metadata).toEqual({ user_id: "user-id-x" })
  })
})
