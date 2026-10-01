/**
 * Sharing the Codex CLI's auth.json, so one account's rotating refresh token is
 * never spent twice (by copilot-api and the CLI).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  codexCliRefreshTokenIfRotated,
  readCodexCliCredentials,
  setCodexCliAuthPathForTest,
  writeCodexCliCredentials,
} from "~/services/oauth/codex-cli-auth"

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "codex-auth-"))
  file = path.join(dir, "auth.json")
  setCodexCliAuthPathForTest(file)
})

afterEach(async () => {
  setCodexCliAuthPathForTest(undefined)
  await rm(dir, { recursive: true, force: true })
})

async function writeCli(contents: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(contents), "utf8")
}

const CLI_FILE = {
  auth_mode: "chatgpt",
  tokens: {
    access_token: "cli-access",
    id_token: "cli-id",
    refresh_token: "cli-refresh",
    account_id: "acct-1",
  },
  last_refresh: "2026-01-01T00:00:00Z",
  extra_field: "keep me",
}

describe("codex cli auth.json sharing", () => {
  test("reads the CLI's tokens for the matching account only", async () => {
    await writeCli(CLI_FILE)
    expect(await readCodexCliCredentials("acct-1")).toMatchObject({
      accessToken: "cli-access",
      refreshToken: "cli-refresh",
      accountId: "acct-1",
    })
    // Another account, or none named: the CLI's file is not ours to read.
    expect(await readCodexCliCredentials("acct-2")).toBeUndefined()
    expect(await readCodexCliCredentials(undefined)).toBeUndefined()
  })

  test("a missing file reads as none, and is never created", async () => {
    expect(await readCodexCliCredentials("acct-1")).toBeUndefined()
    await writeCodexCliCredentials("acct-1", {
      accessToken: "new",
      refreshToken: "new-rt",
      accountId: "acct-1",
    })
    await expect(readFile(file, "utf8")).rejects.toBeDefined()
  })

  test("adopts the CLI's refresh token only when it has rotated", async () => {
    await writeCli(CLI_FILE)
    expect(await codexCliRefreshTokenIfRotated("acct-1", "ours")).toBe(
      "cli-refresh",
    )
    expect(
      await codexCliRefreshTokenIfRotated("acct-1", "cli-refresh"),
    ).toBeUndefined()
    expect(
      await codexCliRefreshTokenIfRotated("acct-2", "ours"),
    ).toBeUndefined()
  })

  test("writes rotated tokens back, keeping the CLI's other fields", async () => {
    await writeCli(CLI_FILE)
    await writeCodexCliCredentials("acct-1", {
      accessToken: "new-access",
      idToken: "new-id",
      refreshToken: "new-refresh",
      accountId: "acct-1",
    })
    const written = JSON.parse(await readFile(file, "utf8")) as {
      tokens: Record<string, string>
      extra_field: string
      last_refresh: string
    }
    expect(written.tokens.access_token).toBe("new-access")
    expect(written.tokens.id_token).toBe("new-id")
    expect(written.tokens.refresh_token).toBe("new-refresh")
    expect(written.tokens.account_id).toBe("acct-1")
    // Everything else the CLI wrote stays.
    expect(written.extra_field).toBe("keep me")
    expect(written.last_refresh).not.toBe("2026-01-01T00:00:00Z")
  })

  test("never writes another account's file", async () => {
    await writeCli(CLI_FILE)
    await writeCodexCliCredentials("acct-2", {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      accountId: "acct-2",
    })
    const written = JSON.parse(await readFile(file, "utf8")) as {
      tokens: Record<string, string>
    }
    expect(written.tokens.access_token).toBe("cli-access")
    expect(written.tokens.refresh_token).toBe("cli-refresh")
  })
})
