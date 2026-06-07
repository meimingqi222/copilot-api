import consola from "consola"

import {
  getMimoPh,
  getMimoProxy,
  getMimoServiceToken,
  getMimoUserId,
  type Account,
} from "~/lib/accounts"
import { state } from "~/lib/state"
import { MimoAccountManager } from "~/services/mimo/account-lifecycle"

export function markAccountFailed(accountId: string, errorMsg: string) {
  const acc = state.accounts.find((a) => a.id === accountId)
  if (acc) {
    acc.runtimeState = {
      ...acc.runtimeState,
      authStatus: "error",
      lastError: errorMsg,
    }
  }
}

export function markAccountReady(accountId: string) {
  const acc = state.accounts.find((a) => a.id === accountId)
  if (acc && acc.runtimeState?.authStatus !== "ready") {
    acc.runtimeState = {
      ...acc.runtimeState,
      authStatus: "ready",
      lastError: undefined,
    }
  }
}

const activeManagers = new Map<string, MimoAccountManager>()

const MIN_CLAW_CREATE_INTERVAL_MS = 600_000

export function startMimoManager() {
  consola.info("🚀 Mimo AI Studio control engine (Manager) initialized.")

  // Reset all existing mimo account authStatus to avoid stale state from
  // previous runs (e.g. "error" after a crash while mimoConnections is empty).
  for (const account of state.accounts) {
    if (
      account.provider === "mimo-aistudio"
      && account.enabled
      && account.runtimeState?.authStatus === "error"
    ) {
      account.runtimeState = {
        ...account.runtimeState,
        authStatus: "pending",
      }
    }
  }

  setInterval(() => {
    for (const [id, mgr] of activeManagers.entries()) {
      const acc = state.accounts.find((a) => a.id === id)
      if (!acc || !acc.enabled || acc.provider !== "mimo-aistudio") {
        consola.info(`Stopping manager for account "${mgr.label}"`)
        mgr.stop()
        activeManagers.delete(id)
      }
    }

    const toStart: Array<{
      account: Account
      serviceToken: string
      ph: string
      userId: string
    }> = []
    for (const account of state.accounts) {
      if (account.provider !== "mimo-aistudio" || !account.enabled) {
        continue
      }
      if (activeManagers.has(account.id)) {
        continue
      }

      const serviceToken = getMimoServiceToken(account)
      const ph = getMimoPh(account)
      const userId = getMimoUserId(account)

      if (!serviceToken || !ph || !userId) {
        consola.warn(
          `Account "${account.label}" has missing Mimo credentials. Skipping.`,
        )
        continue
      }

      toStart.push({ account, serviceToken, ph, userId })
    }

    for (const [
      i,
      { account, serviceToken, ph, userId },
    ] of toStart.entries()) {
      const delay = i * MIN_CLAW_CREATE_INTERVAL_MS
      setTimeout(() => {
        if (activeManagers.has(account.id)) return
        const proxy = getMimoProxy(account)
        const mgr = new MimoAccountManager(
          account.id,
          account.label,
          userId,
          serviceToken,
          ph,
          proxy,
        )
        activeManagers.set(account.id, mgr)
        mgr.runLifecycle().catch((e: unknown) => {
          consola.error(`Manager for account "${account.label}" failed:`, e)
        })
      }, delay)
    }
  }, 15000)
}
