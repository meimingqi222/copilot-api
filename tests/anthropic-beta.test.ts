import { describe, expect, test } from "bun:test"

import { hasClaudeCodeBeta } from "~/routes/messages/anthropic-beta"

describe("hasClaudeCodeBeta", () => {
  test("returns false for empty header", () => {
    expect(hasClaudeCodeBeta(undefined)).toBe(false)
    expect(hasClaudeCodeBeta("")).toBe(false)
  })

  test("returns true when header starts with claude-code beta", () => {
    expect(hasClaudeCodeBeta("claude-code-20250124")).toBe(true)
  })

  test("returns true when claude-code beta is not the first token", () => {
    expect(
      hasClaudeCodeBeta("computer-use-2025-01-24, claude-code-20250124"),
    ).toBe(true)
  })

  test("returns false when claude-code beta is absent", () => {
    expect(hasClaudeCodeBeta("computer-use-2025-01-24")).toBe(false)
  })
})
