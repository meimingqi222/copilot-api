import { afterEach, describe, expect, test } from "bun:test"

import { resetInstallIdForTest } from "~/lib/install-id"
import {
  deriveClaudeDeviceId,
  generateClaudeCloakingUserId,
  generateClaudeJsonUserId,
  isClaudeCloakingUserId,
  isClaudeCodeUserId,
  isClaudeJsonUserId,
  resolveAnthropicMetadataUserId,
} from "~/services/claude/user-id"

afterEach(() => {
  resetInstallIdForTest()
})

// ── isClaudeCloakingUserId / isClaudeJsonUserId ─────────────────────────────

describe("isClaudeCloakingUserId", () => {
  test("accepts a well-formed cloaking id", () => {
    const id = generateClaudeCloakingUserId()
    expect(isClaudeCloakingUserId(id)).toBe(true)
  })

  test("rejects malformed strings", () => {
    expect(isClaudeCloakingUserId("user_abc_account_x_session_y")).toBe(false)
    expect(isClaudeCloakingUserId("")).toBe(false)
    expect(isClaudeCloakingUserId("not-a-cloaking-id")).toBe(false)
  })
})

describe("isClaudeJsonUserId", () => {
  test("accepts a JSON envelope with session_id", () => {
    expect(isClaudeJsonUserId(JSON.stringify({ session_id: "s1" }))).toBe(true)
  })

  test("rejects JSON without session_id", () => {
    expect(isClaudeJsonUserId(JSON.stringify({ device_id: "d1" }))).toBe(false)
  })

  test("rejects non-JSON", () => {
    expect(isClaudeJsonUserId("plain string")).toBe(false)
    expect(isClaudeJsonUserId("")).toBe(false)
  })
})

describe("isClaudeCodeUserId", () => {
  test("accepts either shape", () => {
    expect(isClaudeCodeUserId(generateClaudeCloakingUserId())).toBe(true)
    expect(isClaudeCodeUserId(JSON.stringify({ session_id: "s1" }))).toBe(true)
  })
})

// ── deriveClaudeDeviceId ────────────────────────────────────────────────────

describe("deriveClaudeDeviceId", () => {
  test("is stable: same inputs -> same output", () => {
    const a = deriveClaudeDeviceId("install-1", "account-1")
    const b = deriveClaudeDeviceId("install-1", "account-1")
    expect(a).toBe(b)
  })

  test("differs by install id", () => {
    const a = deriveClaudeDeviceId("install-1", "account-1")
    const b = deriveClaudeDeviceId("install-2", "account-1")
    expect(a).not.toBe(b)
  })

  test("differs by account id (domain-separated v2)", () => {
    const a = deriveClaudeDeviceId("install-1", "account-1")
    const b = deriveClaudeDeviceId("install-1", "account-2")
    expect(a).not.toBe(b)
  })

  test("falls back to install-only hash when no account id", () => {
    const a = deriveClaudeDeviceId("install-1")
    const b = deriveClaudeDeviceId("install-1", undefined)
    expect(a).toBe(b)
    // Different from the account-scoped variant.
    expect(a).not.toBe(deriveClaudeDeviceId("install-1", "account-1"))
  })
})

// ── generateClaudeJsonUserId ────────────────────────────────────────────────

describe("generateClaudeJsonUserId", () => {
  test("produces a JSON envelope with device_id, session_id, account_uuid", async () => {
    const id = await generateClaudeJsonUserId("session-1", "account-1")
    const parsed = JSON.parse(id) as Record<string, string>
    expect(parsed.device_id).toBeTruthy()
    expect(parsed.session_id).toBe("session-1")
    expect(parsed.account_uuid).toBe("account-1")
  })

  test("omits account_uuid when no account id", async () => {
    const id = await generateClaudeJsonUserId("session-1")
    const parsed = JSON.parse(id) as Record<string, string>
    expect(parsed.account_uuid).toBeUndefined()
    expect(parsed.session_id).toBe("session-1")
  })

  test("device_id is stable across calls for the same account", async () => {
    const a = JSON.parse(
      await generateClaudeJsonUserId("s1", "acct"),
    ) as Record<string, string>
    const b = JSON.parse(
      await generateClaudeJsonUserId("s2", "acct"),
    ) as Record<string, string>
    expect(a.device_id).toBe(b.device_id)
  })
})

// ── resolveAnthropicMetadataUserId ──────────────────────────────────────────

describe("resolveAnthropicMetadataUserId", () => {
  test("OAuth: forwards a valid cloaking id verbatim", async () => {
    const cloaking = generateClaudeCloakingUserId()
    const resolved = await resolveAnthropicMetadataUserId(
      cloaking,
      true,
      "s1",
      "a1",
    )
    expect(resolved).toBe(cloaking)
  })

  test("OAuth: forwards a valid JSON envelope verbatim", async () => {
    const json = JSON.stringify({ session_id: "s1", device_id: "d1" })
    const resolved = await resolveAnthropicMetadataUserId(
      json,
      true,
      "s1",
      "a1",
    )
    expect(resolved).toBe(json)
  })

  test("OAuth: drops a non-CC id and generates a fresh CC-style JSON id", async () => {
    const resolved = await resolveAnthropicMetadataUserId(
      "random-string",
      true,
      "session-x",
      "account-y",
    )
    expect(resolved).toBeDefined()
    const parsed = JSON.parse(resolved as string) as Record<string, string>
    expect(parsed.session_id).toBe("session-x")
    expect(parsed.account_uuid).toBe("account-y")
    expect(parsed.device_id).toBeTruthy()
  })

  test("OAuth: generates a JSON id when no caller value", async () => {
    const resolved = await resolveAnthropicMetadataUserId(
      undefined,
      true,
      "session-x",
      "account-y",
    )
    expect(resolved).toBeDefined()
    expect(isClaudeJsonUserId(resolved as string)).toBe(true)
  })

  test("non-OAuth: forwards caller value verbatim", async () => {
    const resolved = await resolveAnthropicMetadataUserId("anything", false)
    expect(resolved).toBe("anything")
  })

  test("non-OAuth: returns undefined when no caller value", async () => {
    const resolved = await resolveAnthropicMetadataUserId(undefined, false)
    expect(resolved).toBeUndefined()
  })
})
