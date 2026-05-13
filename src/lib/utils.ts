import consola from "consola"

import { saveAccounts } from "~/lib/account-store"
import { canonicalNativeModelId } from "~/lib/accounts"
import { listExposedPublicModels } from "~/lib/route-target/build"
import { getVSCodeVersion } from "~/services/get-vscode-version"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

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
  const accountModels = state.accounts
    .map((account, originalIndex) => ({ account, originalIndex }))
    .sort((left, right) => {
      if (left.account.priority !== right.account.priority) {
        return left.account.priority - right.account.priority
      }
      return left.originalIndex - right.originalIndex
    })
    .flatMap(({ account }) =>
      (account.availableModels ?? []).map((model) => ({ model, account })),
    )

  if (accountModels.length > 0) {
    const duplicateCounts = new Map<string, number>()
    for (const entry of accountModels) {
      const nativeModelId = canonicalNativeModelId(entry.model.id)
      duplicateCounts.set(
        nativeModelId,
        (duplicateCounts.get(nativeModelId) ?? 0) + 1,
      )
    }

    const merged = new Map<
      string,
      {
        model: (typeof accountModels)[number]["model"]
        publicId: string
      }
    >()
    for (const entry of accountModels) {
      const providerId = entry.model.provider ?? entry.account.provider
      const nativeModelId = canonicalNativeModelId(entry.model.id)
      const publicIds = [
        entry.model.id,
        ...((duplicateCounts.get(nativeModelId) ?? 0) > 1 ?
          [`${providerId}/${entry.model.id}`]
        : []),
      ]

      for (const publicId of publicIds) {
        if (!merged.has(publicId)) {
          merged.set(publicId, {
            model: entry.model,
            publicId,
          })
        }
      }
    }

    state.models = {
      object: "list",
      data: Array.from(merged.values()).map(({ model, publicId }) => ({
        id: publicId,
        object: "model",
        name: model.name,
        preview: false,
        vendor: model.vendor,
        version: "1",
        model_picker_enabled: model.pickerEnabled,
        model_picker_category: model.pickerCategory,
        supported_endpoints: model.supportedEndpoints,
        capabilities: {
          family: model.provider ?? model.vendor.toLowerCase(),
          object: "capabilities",
          supports: { streaming: true },
          tokenizer: "unknown",
          type: "chat",
        },
      })),
    }
    appendProviderConnectionModels()
    return
  }

  appendProviderConnectionModels()
  if (!state.models) {
    state.models = undefined
  }
}

function endpointToSupported(endpoint: string): string {
  switch (endpoint) {
    case "chat": {
      return "/chat/completions"
    }
    case "messages": {
      return "/v1/messages"
    }
    case "responses": {
      return "/v1/responses"
    }
    case "embeddings": {
      return "/v1/embeddings"
    }
    default: {
      return `/${endpoint}`
    }
  }
}

type ExposedModel = ReturnType<typeof listExposedPublicModels>[number]

function buildConnectionModelEntry(
  id: string,
  entry: ExposedModel,
): NonNullable<typeof state.models>["data"][number] {
  const vendor = entry.vendor ?? entry.connectionId
  return {
    id,
    object: "model",
    name: entry.name ?? id,
    preview: false,
    vendor,
    version: "1",
    model_picker_enabled: entry.pickerEnabled,
    model_picker_category: entry.pickerCategory,
    supported_endpoints: entry.endpoints.map((e) => endpointToSupported(e)),
    capabilities: {
      family: vendor.toLowerCase(),
      object: "capabilities",
      supports: { streaming: true },
      tokenizer: "unknown",
      type: "chat",
    },
  }
}

function appendProviderConnectionModels(): void {
  const exposed = listExposedPublicModels()
  if (exposed.length === 0) return

  // Count distinct connections per publicId: when > 1, also expose
  // provider-pinned entries (connectionId/publicId).
  const connSetByModel = new Map<string, Set<string>>()
  for (const entry of exposed) {
    const s = connSetByModel.get(entry.publicId) ?? new Set<string>()
    connSetByModel.set(entry.publicId, s.add(entry.connectionId))
  }

  const existing = new Set((state.models?.data ?? []).map((m) => m.id))
  const additions: NonNullable<typeof state.models>["data"] = []
  const autoLbSeen = new Set<string>()

  for (const entry of exposed) {
    // Auto-LB entry: bare publicId (added once, load-balanced across all providers)
    if (!autoLbSeen.has(entry.publicId)) {
      autoLbSeen.add(entry.publicId)
      if (!existing.has(entry.publicId)) {
        existing.add(entry.publicId)
        additions.push(buildConnectionModelEntry(entry.publicId, entry))
      }
    }

    // Provider-pinned entry: connectionId/publicId — only when multiple connections
    // serve the same publicId, letting the client target a specific provider.
    if ((connSetByModel.get(entry.publicId)?.size ?? 1) > 1) {
      const pinnedId = `${entry.connectionId}/${entry.publicId}`
      if (!existing.has(pinnedId)) {
        existing.add(pinnedId)
        additions.push(buildConnectionModelEntry(pinnedId, entry))
      }
    }
  }

  if (additions.length === 0 && state.models) return
  state.models = {
    object: "list",
    data: [...(state.models?.data ?? []), ...additions],
  }
}

export async function refreshModelsForAccount(account: Account): Promise<void> {
  initializeProviderRegistry()
  try {
    account.availableModels = await getProviderRuntime(
      account.provider,
    ).refreshModels(account)
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

    if (account.provider === "codebuff") {
      account.availableModels = [
        {
          id: state.codebuffModel,
          name: state.codebuffModel,
          vendor: "codebuff",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions"],
          provider: "codebuff",
        },
      ]
      await saveAccounts()
      cacheModels()
      return
    }

    if (account.provider === "windsurf") {
      account.availableModels = [
        {
          id: state.providerDefaults.windsurf.defaultModel,
          name: state.providerDefaults.windsurf.defaultModel,
          vendor: "Windsurf",
          pickerEnabled: true,
          supportedEndpoints: ["/chat/completions", "/v1/messages"],
          provider: "windsurf",
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
