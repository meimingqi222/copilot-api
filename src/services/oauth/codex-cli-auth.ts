/**
 * The Codex CLI's own sign-in file (`~/.codex/auth.json`).
 *
 * OpenAI rotates the refresh token on every refresh, so a second copy of the
 * same account — copilot-api's stored credential and the Codex CLI's file —
 * will invalidate the other the moment either refreshes. The reference
 * implementation avoids this by treating the CLI's file as the token store.
 *
 * This module does the same, defensively: it only ever touches the file when
 * it exists and holds *the same account* (the `tokens.account_id` matches), it
 * preserves every other field the CLI wrote, and it writes atomically.
 *
 * - before we refresh, if the CLI has rotated the token (its refresh token
 *   differs from ours) we adopt the CLI's, so we never consume one it already
 *   spent;
 * - after we refresh, we write the rotated tokens back, so the CLI never
 *   consumes one we spent.
 */

import { readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import { logger } from "~/lib/logger"

interface CodexCliTokens {
  access_token?: string
  id_token?: string
  refresh_token?: string
  account_id?: string
}

interface CodexCliAuthFile {
  tokens?: CodexCliTokens
  last_refresh?: string
  [key: string]: unknown
}

export interface CodexCliCredentials {
  accessToken: string
  idToken?: string
  refreshToken?: string
  accountId?: string
}

let authPathOverride: string | undefined

/** Test seam: point the module at another auth.json (or `undefined` to reset). */
export function setCodexCliAuthPathForTest(p?: string): void {
  authPathOverride = p
}

function codexCliAuthPath(): string {
  return authPathOverride ?? path.join(homedir(), ".codex", "auth.json")
}

async function readFileJson(): Promise<CodexCliAuthFile | undefined> {
  try {
    return JSON.parse(
      await readFile(codexCliAuthPath(), "utf8"),
    ) as CodexCliAuthFile
  } catch {
    return undefined
  }
}

function sameAccount(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a.trim() === b.trim()
}

/**
 * The CLI's tokens when its file holds the account `accountId`, else undefined.
 * A missing file, an unreadable one, or one for another account reads as none.
 */
export async function readCodexCliCredentials(
  accountId: string | undefined,
): Promise<CodexCliCredentials | undefined> {
  if (!accountId) return undefined
  const file = await readFileJson()
  const tokens = file?.tokens
  if (!tokens?.access_token) return undefined
  if (!sameAccount(tokens.account_id, accountId)) return undefined
  return {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    accountId: tokens.account_id,
  }
}

/**
 * The refresh token to use for this account: the CLI's when it has rotated
 * since ours (a different token), otherwise ours. Undefined when the CLI's file
 * has nothing newer to offer.
 */
export async function codexCliRefreshTokenIfRotated(
  accountId: string | undefined,
  ourRefreshToken: string | undefined,
): Promise<string | undefined> {
  const cli = await readCodexCliCredentials(accountId)
  if (!cli?.refreshToken) return undefined
  if (cli.refreshToken === ourRefreshToken) return undefined
  return cli.refreshToken
}

/**
 * Write rotated tokens back into the CLI's file, so it doesn't refresh a token
 * we already spent. Only touches a file that already exists for this account;
 * every other field is kept as the CLI wrote it. Never throws.
 */
export async function writeCodexCliCredentials(
  accountId: string | undefined,
  credentials: CodexCliCredentials,
): Promise<void> {
  if (!accountId) return
  const file = await readFileJson()
  const tokens = file?.tokens
  if (!file || !tokens?.access_token) return
  if (!sameAccount(tokens.account_id, accountId)) return

  const next: CodexCliAuthFile = {
    ...file,
    tokens: {
      ...tokens,
      access_token: credentials.accessToken,
      ...(credentials.idToken ? { id_token: credentials.idToken } : {}),
      ...(credentials.refreshToken ?
        { refresh_token: credentials.refreshToken }
      : {}),
    },
    last_refresh: new Date().toISOString(),
  }

  const p = codexCliAuthPath()
  const tmp = `${p}.${process.pid}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, p)
  } catch (error: unknown) {
    logger.debug(
      `Codex CLI auth.json not written back: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
