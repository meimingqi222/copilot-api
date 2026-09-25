import { describe, expect, test } from "bun:test"

import { cleanClaudeEnv } from "~/services/claude/cli/env"

const BASE = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/tester",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:4141",
  ANTHROPIC_API_KEY: "sk-should-not-leak",
  ANTHROPIC_AUTH_TOKEN: "tok-should-not-leak",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SSE_PORT: "12345",
  CLAUDE_CODE_OAUTH_TOKEN: "user-env-token",
  UNRELATED: "kept",
}

describe("cleanClaudeEnv", () => {
  test("drops every gateway and nesting override", () => {
    const env = cleanClaudeEnv(BASE)
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SSE_PORT",
    ]) {
      expect(env[key]).toBeUndefined()
    }
  })

  test("drops a user-supplied oauth token when none is injected", () => {
    const env = cleanClaudeEnv(BASE)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test("keeps unrelated variables", () => {
    const env = cleanClaudeEnv(BASE)
    expect(env.PATH).toBe("/usr/bin:/bin")
    expect(env.HOME).toBe("/home/tester")
    expect(env.UNRELATED).toBe("kept")
  })

  test("adds the forced variables", () => {
    const env = cleanClaudeEnv(BASE)
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("0")
    expect(env.DISABLE_AUTO_COMPACT).toBe("1")
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1")
  })

  test("injects the connection's own token, overriding the user's", () => {
    const env = cleanClaudeEnv(BASE, { oauthToken: "connection-token" })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("connection-token")
  })

  test("ignores a blank token", () => {
    const env = cleanClaudeEnv(BASE, { oauthToken: "   " })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test("does not mutate the base environment", () => {
    const before = { ...BASE }
    cleanClaudeEnv(BASE, { oauthToken: "t" })
    expect(BASE).toEqual(before)
  })

  test("applies overrides last, and deletes on undefined", () => {
    const env = cleanClaudeEnv(BASE, {
      overrides: { PATH: "/custom", HOME: undefined },
    })
    expect(env.PATH).toBe("/custom")
    expect(env.HOME).toBeUndefined()
  })

  test("returns only string values", () => {
    const env = cleanClaudeEnv({ KEEP: "1", DROP: undefined })
    expect(env.DROP).toBeUndefined()
    expect(Object.values(env).every((v) => typeof v === "string")).toBe(true)
  })
})
