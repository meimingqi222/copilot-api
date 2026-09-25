import { afterEach, describe, expect, test } from "bun:test"

import { setClaudeCliTestHooks } from "~/services/claude/cli/binary"
import { ClaudeCliUnavailableError } from "~/services/claude/cli/errors"
import { resolveClaudeTransport } from "~/services/claude/cli/transport"

import { testConnection } from "./claude-cli-fixtures"

afterEach(() => {
  setClaudeCliTestHooks({})
  delete process.env.COPILOT_API_CLAUDE_TRANSPORT
})

function withBinary(): void {
  setClaudeCliTestHooks({ findBinary: () => "/usr/local/bin/claude" })
}

function withoutBinary(): void {
  setClaudeCliTestHooks({ findBinary: () => undefined })
}

describe("resolveClaudeTransport", () => {
  test("auto-selects the CLI when the binary is installed", () => {
    withBinary()
    expect(resolveClaudeTransport(testConnection())).toBe("cli")
  })

  test("falls back to v1 when the binary is missing", () => {
    withoutBinary()
    expect(resolveClaudeTransport(testConnection())).toBe("http")
  })

  test("honours an explicit per-connection opt-out", () => {
    withBinary()
    const connection = testConnection({
      metadata: { claudeTransport: "http" },
    })
    expect(resolveClaudeTransport(connection)).toBe("http")
  })

  test("honours an explicit per-connection opt-in", () => {
    withBinary()
    const connection = testConnection({ metadata: { claudeTransport: "cli" } })
    expect(resolveClaudeTransport(connection)).toBe("cli")
  })

  /**
   * Silently falling back to v1 would be the worst failure mode: the operator
   * believes they are on the safe path while traffic keeps being replayed with
   * a forged fingerprint. An explicit opt-in must fail loudly instead.
   */
  test("throws when the CLI is opted into but not installed", () => {
    withoutBinary()
    const connection = testConnection({ metadata: { claudeTransport: "cli" } })
    expect(() => resolveClaudeTransport(connection)).toThrow(
      ClaudeCliUnavailableError,
    )
    try {
      resolveClaudeTransport(connection)
    } catch (error) {
      expect((error as Error).message).toContain("claude")
    }
  })

  test("the global kill-switch beats a per-connection opt-in", () => {
    withBinary()
    process.env.COPILOT_API_CLAUDE_TRANSPORT = "http"
    const connection = testConnection({ metadata: { claudeTransport: "cli" } })
    expect(resolveClaudeTransport(connection)).toBe("http")
  })

  test("the global kill-switch beats auto-selection", () => {
    withBinary()
    process.env.COPILOT_API_CLAUDE_TRANSPORT = "http"
    expect(resolveClaudeTransport(testConnection())).toBe("http")
  })

  test("the kill-switch is case and whitespace tolerant", () => {
    withBinary()
    process.env.COPILOT_API_CLAUDE_TRANSPORT = "  HTTP  "
    expect(resolveClaudeTransport(testConnection())).toBe("http")
  })

  test("ignores an unrecognised metadata value", () => {
    withBinary()
    const connection = testConnection({ metadata: { claudeTransport: "nope" } })
    expect(resolveClaudeTransport(connection)).toBe("cli")
  })

  test("ignores metadata of the wrong type", () => {
    withoutBinary()
    const connection = testConnection({ metadata: { claudeTransport: true } })
    expect(resolveClaudeTransport(connection)).toBe("http")
  })
})
