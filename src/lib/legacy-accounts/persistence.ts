/**
 * Account 持久化 facade。
 *
 * Phase 3:从 account-store.ts 提取的 saveAccounts/flush 逻辑。
 * saveAccounts 委托 saveProviderConnections,accounts.json 永不复活。
 */
import fs from "node:fs/promises"

import {
  accountsDiskHasRecoverableData,
  listAccounts,
} from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import {
  listProviderConnections,
  saveProviderConnections,
} from "~/lib/provider-connections"
import { emitStateChange } from "~/lib/state-events"

import { accountsLifecycleMutex } from "./boot-migration"

export interface SaveAccountsOptions {
  /** Allow persisting an empty list (e.g. user deleted the last account). */
  allowEmpty?: boolean
  /** Allow reducing the number of accounts on disk (e.g. user deleted accounts). */
  allowShrink?: boolean
}

/**
 * 持久化当前 connections 到 provider-connections.json。
 */
export async function saveAccounts(
  options: SaveAccountsOptions = {},
): Promise<void> {
  return accountsLifecycleMutex.runExclusive(async () => {
    await saveAccountsUnlocked(options)
  })
}

/**
 * Shutdown 时 flush in-memory connections 到磁盘。
 */
export async function flushAccountsOnShutdown(): Promise<void> {
  return accountsLifecycleMutex.runExclusive(async () => {
    if (listAccounts().length === 0) return
    await saveProviderConnections(listProviderConnections())
  })
}

async function saveAccountsUnlocked(
  options: SaveAccountsOptions = {},
): Promise<void> {
  const accountCount = listAccounts().length
  if (accountCount === 0 && !options.allowEmpty) {
    const diskHasData =
      listProviderConnections().length > 0
      || (await accountsDiskHasRecoverableData())
      || (await connectionsDiskHasData())
    if (diskHasData) {
      logger.warn(
        "Refusing to persist empty accounts snapshot while existing data is on disk",
      )
      return
    }
  }

  await saveProviderConnections(listProviderConnections())
  emitStateChange("models-stale")
}

async function connectionsDiskHasData(): Promise<boolean> {
  try {
    const raw = await fs.readFile(PATHS.PROVIDER_CONNECTIONS_PATH)
    const parsed = JSON.parse(raw.toString("utf8")) as {
      connections?: Array<unknown>
    }
    return (parsed.connections?.length ?? 0) > 0
  } catch {
    return false
  }
}
