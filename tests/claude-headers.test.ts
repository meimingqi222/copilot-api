import { describe, expect, test } from "bun:test"

import { claudeCodeVersion } from "~/services/claude/fingerprint"
import {
  buildClaudeCodeBetas,
  buildClaudeOAuthHeaders,
  claudeCodeFingerprintHeaders,
  stripEnforcedFingerprintHeaders,
} from "~/services/claude/headers"

describe("buildClaudeCodeBetas", () => {
  test("builds the current Cowork agent profile", () => {
    expect(buildClaudeCodeBetas(true, true).split(",")).toEqual([
      "claude-code-20250219",
      "interleaved-thinking-2025-05-14",
      "thinking-token-count-2026-05-13",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "mid-conversation-system-2026-04-07",
      "advanced-tool-use-2025-11-20",
      "effort-2025-11-24",
      "fallback-credit-2026-06-01",
    ])
  })

  test("builds the utility profile without agent-only betas", () => {
    const betas = buildClaudeCodeBetas(false).split(",")
    expect(betas).toEqual([
      "interleaved-thinking-2025-05-14",
      "thinking-token-count-2026-05-13",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "structured-outputs-2025-12-15",
    ])
    expect(betas).not.toContain("oauth-2025-04-20")
  })

  test("appends extra caller betas and deduplicates core values", () => {
    const betas = buildClaudeCodeBetas(true, false, [
      "thinking-token-count-2026-05-13",
      "my-custom-beta-2026-01-01",
    ]).split(",")
    expect(
      betas.filter((beta) => beta === "thinking-token-count-2026-05-13"),
    ).toHaveLength(1)
    expect(betas.at(-1)).toBe("my-custom-beta-2026-01-01")
  })

  test("accepts the legacy extra-beta call shape", () => {
    const betas = buildClaudeCodeBetas(true, ["custom-beta"]).split(",")
    expect(betas).toContain("custom-beta")
  })
})

describe("buildClaudeOAuthHeaders", () => {
  test("matches the current Cowork fingerprint headers", async () => {
    const headers = await buildClaudeOAuthHeaders({
      accessToken: "tok",
      stream: true,
    })
    for (const [key, value] of Object.entries(claudeCodeFingerprintHeaders)) {
      expect(headers[key]).toBe(value)
    }
    expect(headers["User-Agent"]).toBe(
      `claude-cli/${claudeCodeVersion} (external, claude-desktop)`,
    )
    expect(headers["anthropic-client-platform"]).toBeUndefined()
    expect(headers["anthropic-client-version"]).toBeUndefined()
    expect(headers["X-Stainless-Timeout"]).toBe("600")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
  })

  test("uses application/json for OAuth streaming and non-streaming", async () => {
    const stream = await buildClaudeOAuthHeaders({
      accessToken: "tok",
      stream: true,
    })
    expect(stream.Accept).toBe("application/json")
    expect(stream["Accept-Encoding"]).toBe("identity")

    const nonStream = await buildClaudeOAuthHeaders({
      accessToken: "tok",
      stream: false,
    })
    expect(nonStream.Accept).toBe("application/json")
    expect(nonStream["Accept-Encoding"]).toBe("gzip, deflate, br, zstd")
  })

  test("pins anthropic-version and ignores caller beta core overrides", async () => {
    const headers = await buildClaudeOAuthHeaders({
      accessToken: "tok",
      anthropicVersion: "2099-01-01",
      anthropicBeta: "oauth-2025-04-20,my-extra-beta",
    })
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    expect(headers["anthropic-beta"]).not.toContain("oauth-2025-04-20")
    expect(headers["anthropic-beta"]).toContain("my-extra-beta")
  })

  test("uses one stable session id when supplied", async () => {
    const headers = await buildClaudeOAuthHeaders({
      accessToken: "tok",
      sessionId: "caller-session-id",
    })
    expect(headers["X-Claude-Code-Session-Id"]).toBe("caller-session-id")
  })

  test("generates a stable session id per credential and fresh request ids", async () => {
    const a = await buildClaudeOAuthHeaders({
      accessToken: "tok",
      credentialKey: "acct-1",
    })
    const b = await buildClaudeOAuthHeaders({
      accessToken: "tok",
      credentialKey: "acct-1",
    })
    expect(a["X-Claude-Code-Session-Id"]).toBe(b["X-Claude-Code-Session-Id"])
    expect(a["x-client-request-id"]).not.toBe(b["x-client-request-id"])
  })
})

describe("stripEnforcedFingerprintHeaders", () => {
  test("removes fingerprint keys case-insensitively", () => {
    expect(
      stripEnforcedFingerprintHeaders({
        "User-Agent": "evil-agent",
        "ANTHROPIC-VERSION": "2099-01-01",
        "X-Stainless-Timeout": "1",
        Authorization: "Bearer leak",
        "x-request-id": "trace-123",
      }),
    ).toEqual({ "x-request-id": "trace-123" })
  })
})
