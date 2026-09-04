import fs from "node:fs/promises"

import { logger } from "~/lib/logger"
import {
  assertWritableDataPath,
  isProductionDataPath,
  isTestDataIsolationEnabled,
  PATHS,
} from "~/lib/paths"

export function getAccountsBackupPath(): string {
  return `${PATHS.ACCOUNTS_PATH}.bak`
}

function getAccountsCorruptPath(): string {
  return `${PATHS.ACCOUNTS_PATH}.corrupt`
}

function getAccountsEmptyArchivePath(): string {
  return `${PATHS.ACCOUNTS_PATH}.empty-${Date.now()}.bak`
}

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

/** True when backup exists and contains at least one account entry. */
export async function accountsBackupHasEntries(): Promise<boolean> {
  const backup = await readAccountsFileWithStatus(getAccountsBackupPath())
  return backup.status === "ok" && backup.accounts.length > 0
}

/** True when disk already has a non-empty accounts snapshot worth protecting. */
export async function accountsDiskHasRecoverableData(): Promise<boolean> {
  if (await accountsBackupHasEntries()) return true
  const primary = await readAccountsFileWithStatus(PATHS.ACCOUNTS_PATH)
  return primary.status === "ok" && primary.accounts.length > 0
}

async function recoverFromBackup(
  reason: string,
  corruptPath?: string,
): Promise<AccountsFileReadResult | null> {
  const backup = await readAccountsFileWithStatus(getAccountsBackupPath())
  if (backup.status !== "ok" || backup.accounts.length === 0) {
    return null
  }

  logger.warn(`${reason} — recovering from accounts.json.bak`)
  // Never mutate production data files while tests are isolated.
  if (
    isTestDataIsolationEnabled()
    && isProductionDataPath(PATHS.ACCOUNTS_PATH)
  ) {
    logger.warn(
      "Skipping accounts.json recovery write — production path blocked during tests",
    )
    return { status: "found", accounts: backup.accounts }
  }
  if (corruptPath) {
    const archivePath =
      corruptPath === PATHS.ACCOUNTS_PATH ?
        getAccountsEmptyArchivePath()
      : `${getAccountsCorruptPath()}.${Date.now()}`
    await fs.copyFile(corruptPath, archivePath).catch((error: unknown) => {
      logger.debug(
        `Failed to archive corrupt file: ${(error as Error).message}`,
      )
    })
  }

  try {
    assertWritableDataPath(PATHS.ACCOUNTS_PATH, "recover")
    await fs.copyFile(getAccountsBackupPath(), PATHS.ACCOUNTS_PATH)
  } catch {
    // Best-effort restore of primary file; in-memory load still uses backup data.
  }

  logger.info(
    `Recovered ${backup.accounts.length} account(s) from accounts.json.bak`,
  )
  return { status: "found", accounts: backup.accounts }
}

/**
 * Read accounts.json with corruption detection and .bak fallback.
 * Corrupt/empty files are recovered from .bak when possible. If neither file is
 * readable, throw instead of returning an empty list that could overwrite data.
 *
 * Phase 5:file-store.ts 为只读模块。accounts.json 永不复活(禁忌 #2),
 * 所有写入经 saveProviderConnections → provider-connections.json。
 */
export async function tryReadAccountsFile(): Promise<AccountsFileReadResult> {
  const result = await readAccountsFileWithStatus(PATHS.ACCOUNTS_PATH)
  if (result.status === "ok") {
    if (result.accounts.length === 0) {
      const recovered = await recoverFromBackup(
        "accounts.json is an empty array",
        PATHS.ACCOUNTS_PATH,
      )
      if (recovered) return recovered
      return { status: "found", accounts: result.accounts }
    }
    return { status: "found", accounts: result.accounts }
  }
  if (result.status === "corrupt") {
    logger.warn(
      `accounts.json at ${result.path} is corrupt or empty — attempting .bak fallback`,
    )
    const recovered = await recoverFromBackup(
      "accounts.json is corrupt or empty",
      result.path,
    )
    if (recovered) return recovered
    const corruptDest = `${getAccountsCorruptPath()}.${Date.now()}`
    await fs.copyFile(result.path, corruptDest).catch((error: unknown) => {
      logger.debug(
        `Failed to preserve corrupt file: ${(error as Error).message}`,
      )
    })
    throw new Error(
      `Could not recover accounts from ${result.path}; corrupt file preserved at ${corruptDest}`,
    )
  }
  const recovered = await recoverFromBackup("accounts.json is missing")
  if (recovered) return recovered
  return { status: "missing" }
}
