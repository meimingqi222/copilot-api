import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { connectionToAccount, listAccounts } from "~/lib/legacy-accounts"
import { listAccountManagedConnections } from "~/lib/provider-connections"
import {
  importCpaAuthRecords,
  mapCpaRecordToConnection,
  parseCpaAuthPayload,
} from "~/services/oauth/cpa-import"
import {
  parseExpiresAt,
  substituteTokenInHeaders,
} from "~/services/oauth/token-resolver"

import { setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = listAccounts()

beforeEach(() => {
  setTestAccounts([])
})

afterEach(() => {
  setTestAccounts(originalAccounts)
})

describe("CPA auth import", () => {
  test("maps codex CPA record to OAuth account", () => {
    const conn = mapCpaRecordToConnection({
      type: "codex",
      access_token: "at_test",
      refresh_token: "rt_test",
      account_id: "acct_123",
      email: "user@example.com",
      expired: "1893456000",
    })
    const account = connectionToAccount(conn)

    expect(account.provider).toBe("codex")
    expect(account.credentials?.accessToken).toBe("at_test")
    expect(account.credentials?.refreshToken).toBe("rt_test")
    expect(account.credentials?.accountId).toBe("acct_123")
    expect(account.credentials?.expiresAt).toBe(1_893_456_000_000)
    expect(account.label).toBe("user@example.com")
  })

  test("normalizes x-ai provider alias", () => {
    const conn = mapCpaRecordToConnection({
      type: "x-ai",
      access_token: "xai_token",
    })
    const account = connectionToAccount(conn)

    expect(account.provider).toBe("xai")
    expect(account.settings?.tokenEndpoint).toContain("/oauth2/token")
  })

  test("strips tokens from cpaMetadata", () => {
    const conn = mapCpaRecordToConnection({
      type: "claude",
      access_token: "secret-access",
      refresh_token: "secret-refresh",
      email: "user@example.com",
    })
    const account = connectionToAccount(conn)

    expect(account.cpaMetadata?.email).toBe("user@example.com")
    expect(account.cpaMetadata).not.toHaveProperty("access_token")
    expect(account.cpaMetadata).not.toHaveProperty("refresh_token")
  })

  test("overwrite replaces duplicate CPA account", () => {
    importCpaAuthRecords(
      [{ type: "claude", access_token: "claude-1", email: "a@example.com" }],
      { existingConnections: listAccountManagedConnections() },
    )
    expect(listAccounts()).toHaveLength(1)
    const first = listAccounts()[0] as {
      credentials?: { accessToken?: string }
    }
    expect(first.credentials?.accessToken).toBe("claude-1")

    const result = importCpaAuthRecords(
      [{ type: "claude", access_token: "claude-2", email: "a@example.com" }],
      { overwrite: true, existingConnections: listAccountManagedConnections() },
    )

    expect(result.imported).toHaveLength(1)
    expect(listAccounts()).toHaveLength(1)
    const replaced = listAccounts()[0] as {
      credentials?: { accessToken?: string }
    }
    expect(replaced.credentials?.accessToken).toBe("claude-2")
  })

  test("imports multiple CPA records with skip duplicates", () => {
    const result = importCpaAuthRecords(
      [
        { type: "claude", access_token: "claude-1", email: "a@example.com" },
        { type: "kimi", access_token: "kimi-1", email: "b@example.com" },
      ],
      { existingConnections: listAccountManagedConnections() },
    )

    expect(result.imported).toHaveLength(2)
    expect(listAccounts()).toHaveLength(2)

    const skipped = importCpaAuthRecords(
      [{ type: "claude", access_token: "claude-2", email: "a@example.com" }],
      { existingConnections: listAccountManagedConnections() },
    )
    expect(skipped.skipped).toHaveLength(1)
    expect(listAccounts()).toHaveLength(2)
  })

  test("parses CPA payload variants", () => {
    expect(
      parseCpaAuthPayload([{ type: "codex", access_token: "a" }]),
    ).toHaveLength(1)
    expect(
      parseCpaAuthPayload({
        auths: [{ type: "claude", access_token: "a" }],
      }),
    ).toHaveLength(1)
    expect(
      parseCpaAuthPayload({ type: "kimi", access_token: "a" }),
    ).toHaveLength(1)
  })

  test("substitutes token placeholder in headers", () => {
    const headers = substituteTokenInHeaders(
      { Authorization: "Bearer $TOKEN$" },
      "secret-token",
    )
    expect(headers.Authorization).toBe("Bearer secret-token")
  })

  test("parses unix and iso expiry values", () => {
    expect(parseExpiresAt("1893456000")).toBe(1_893_456_000_000)
    expect(parseExpiresAt("2027-01-01T00:00:00.000Z")).toBe(
      Date.parse("2027-01-01T00:00:00.000Z"),
    )
  })
})
