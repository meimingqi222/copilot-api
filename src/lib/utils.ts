import consola from "consola"

import { saveAccounts } from "~/lib/accounts"
import { getCodebuffModelsForAccount } from "~/services/codebuff/get-models"
import { getModelsForAccount } from "~/services/copilot/get-models"
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

export function cacheModels(): void {
  const accountModels = state.accounts.flatMap((account) =>
    (account.availableModels ?? []).map((model) => ({ model, account })),
  )

  if (accountModels.length > 0) {
    const merged = new Map<string, (typeof accountModels)[number]["model"]>()
    for (const entry of accountModels) {
      if (!merged.has(entry.model.id)) {
        merged.set(entry.model.id, entry.model)
      }
    }

    state.models = {
      object: "list",
      data: Array.from(merged.values()).map((model) => ({
        id: model.id,
        object: "model",
        name: model.name,
        preview: false,
        vendor: model.vendor,
        version: "1",
        model_picker_enabled: model.pickerEnabled,
        model_picker_category: model.pickerCategory,
        supported_endpoints: model.supportedEndpoints,
        capabilities: {
          family:
            model.vendor.toLowerCase() === "codebuff" ? "codebuff" : "copilot",
          object: "capabilities",
          supports: { streaming: true },
          tokenizer: "unknown",
          type: "chat",
        },
      })),
    }
    return
  }

  state.models = undefined
}

export async function refreshModelsForAccount(account: Account): Promise<void> {
  try {
    const provider = account.provider ?? "copilot"

    if (provider === "codebuff") {
      // eslint-disable-next-line require-atomic-updates
      account.availableModels = await getCodebuffModelsForAccount(account)
      consola.debug(
        `Models for "${account.label}": ${account.availableModels.map((m) => m.id).join(", ")}`,
      )
      await saveAccounts()
      cacheModels()
      return
    }

    if (!account.copilotToken) return
    const models = await getModelsForAccount(account)
    const seen = new Set<string>()
    // eslint-disable-next-line require-atomic-updates
    account.availableModels = models.data
      .filter((m) => {
        if (m.policy?.state !== "enabled") return false
        if (seen.has(m.id)) return false
        seen.add(m.id)
        return true
      })
      .map((m) => ({
        id: m.id,
        name: m.name,
        vendor: m.vendor,
        pickerEnabled: m.model_picker_enabled,
        pickerCategory: m.model_picker_category,
        supportedEndpoints: m.supported_endpoints ?? [],
      }))
    consola.debug(
      `Models for "${account.label}": ${account.availableModels.map((m) => m.id).join(", ")}`,
    )
    await saveAccounts()
    cacheModels()
  } catch (error) {
    consola.warn(
      `Failed to refresh models for account "${account.label}":`,
      error,
    )

    if ((account.provider ?? "copilot") === "codebuff") {
      account.availableModels = [
        {
          id: state.codebuffModel,
          name: state.codebuffModel,
          vendor: "codebuff",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions"],
        },
      ]
      await saveAccounts()
      cacheModels()
    }
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
