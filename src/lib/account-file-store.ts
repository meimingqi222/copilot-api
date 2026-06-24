import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"

export function getAccountsBackupPath(): string {
  return `${PATHS.ACCOUNTS_PATH}.bak`
}

function getAccountsCorruptPath(): string {
  return `${PATHS.ACCOUNTS_PATH}.corrupt`
}
const RENAME_RETRY_COUNT = 3
const RENAME_RETRY_DELAY_MS = 200

type ReadResult =
  | { status: "ok"; accounts: Array<Record<string, unknown>> }
  | { status: "missing" }
  | { status: "corrupt"; path: string }

async function readAccountsFileWithStatus(
  filePath: string,
): Promise<ReadResult> {
  let data: Buffer
  try {
    data = await fs.readFile(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" }
    }
    throw error
  }
  const text = data.toString("utf8").trim()
  if (!text) {
    return { status: "corrupt", path: filePath }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) {
      return { status: "corrupt", path: filePath }
    }
    return {
      status: "ok",
      accounts: parsed as Array<Record<string, unknown>>,
    }
  } catch {
    return { status: "corrupt", path: filePath }
  }
}

export type AccountsFileReadResult =
  | { status: "found"; accounts: Array<Record<string, unknown>> }
  | { status: "missing" }

/**
 * Read accounts.json with corruption detection and .bak fallback.
 * Corrupt files are recovered from .bak when possible. If neither file is
 * readable, throw instead of returning an empty list that could overwrite data.
 */
export async function tryReadAccountsFile(): Promise<AccountsFileReadResult> {
  const result = await readAccountsFileWithStatus(PATHS.ACCOUNTS_PATH)
  if (result.status === "ok") {
    return { status: "found", accounts: result.accounts }
  }
  if (result.status === "corrupt") {
    consola.warn(
      `accounts.json at ${result.path} is corrupt or empty — attempting .bak fallback`,
    )
    const backup = await readAccountsFileWithStatus(getAccountsBackupPath())
    if (backup.status === "ok") {
      consola.info("Recovered accounts from accounts.json.bak")
      return { status: "found", accounts: backup.accounts }
    }
    const corruptDest = `${getAccountsCorruptPath()}.${Date.now()}`
    await fs.copyFile(result.path, corruptDest).catch(() => {})
    throw new Error(
      `Could not recover accounts from ${result.path}; corrupt file preserved at ${corruptDest}`,
    )
  }
  const backup = await readAccountsFileWithStatus(getAccountsBackupPath())
  if (backup.status === "ok") {
    consola.info("accounts.json missing — recovered from accounts.json.bak")
    return { status: "found", accounts: backup.accounts }
  }
  return { status: "missing" }
}

async function retryRename(source: string, target: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < RENAME_RETRY_COUNT; attempt++) {
    try {
      await fs.rename(source, target)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      // Retry on Windows EPERM/EBUSY/EACCES (file locked by AV/reader)
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        throw error
      }
      if (attempt < RENAME_RETRY_COUNT - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, RENAME_RETRY_DELAY_MS * (attempt + 1)),
        )
      }
    }
  }
  throw lastError
}

/**
 * Atomically write the serialized accounts array to accounts.json.
 * Before replacing the existing file, copies it to accounts.json.bak
 * so we can recover if the rename is interrupted or the new file is bad.
 * Retries the rename on Windows lock errors (EPERM/EBUSY/EACCES).
 */
export async function writeAccountsFile(
  sanitized: Array<Record<string, unknown>>,
): Promise<void> {
  const targetPath = PATHS.ACCOUNTS_PATH
  const appDir = PATHS.APP_DIR
  const tmpPath = `${targetPath}.${process.pid}.tmp`
  try {
    await fs.mkdir(appDir, { recursive: true })
    await fs.writeFile(tmpPath, JSON.stringify(sanitized, null, 2), "utf8")
    try {
      await fs.copyFile(targetPath, getAccountsBackupPath())
    } catch {
      // No existing file yet — that's fine
    }
    await retryRename(tmpPath, targetPath)
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {})
    throw error
  }
}
