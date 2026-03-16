import consola from "consola"

import { getModels, getModelsForAccount } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import type { Account } from "./accounts"

import { state } from "./state"

const MODELS_REFRESH_INTERVAL_MS = 10 * 60 * 1000

function makeSleepAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeSleepAbortError(signal))
      return
    }

    const onAbort = (sig: AbortSignal) => {
      clearTimeout(id)
      sig.removeEventListener("abort", boundOnAbort)
      reject(makeSleepAbortError(sig))
    }

    const boundOnAbort = onAbort.bind(null, signal as AbortSignal)

    const id = setTimeout(() => {
      signal?.removeEventListener("abort", boundOnAbort)
      resolve()
    }, ms)

    signal?.addEventListener("abort", boundOnAbort, { once: true })
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  try {
    const models = await getModels()
    state.models = models
  } catch (error) {
    consola.warn("Failed to cache models (no active accounts yet):", error)
    state.models = undefined
  }
}

export async function refreshModelsForAccount(account: Account): Promise<void> {
  try {
    if (!account.copilotToken) return
    const models = await getModelsForAccount(account)
    // eslint-disable-next-line require-atomic-updates
    account.availableModels = models.data.map((m) => m.id)
    consola.debug(
      `Models for "${account.label}": ${account.availableModels.join(", ")}`,
    )
  } catch (error) {
    consola.warn(
      `Failed to refresh models for account "${account.label}":`,
      error,
    )
  }
}

export async function refreshModelsForAllAccounts(): Promise<void> {
  for (const account of state.accounts) {
    await refreshModelsForAccount(account)
  }
}

export function scheduleModelsRefresh(): void {
  void refreshModelsForAllAccounts()
  setInterval(() => {
    void refreshModelsForAllAccounts()
  }, MODELS_REFRESH_INTERVAL_MS)
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
