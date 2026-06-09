import consola from "consola"
import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import type { Account, AccountProvider } from "~/lib/accounts"

import {
  refreshCopilotToken,
  refreshQuotaForAccount,
  saveAccounts,
} from "~/lib/account-store"
import { cancelTokenRefreshTimer } from "~/lib/account-store"
import { setGitHubToken, addAccount } from "~/lib/accounts"
import { isProviderId } from "~/lib/provider-config"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { refreshModelsForAccount } from "~/lib/utils"

export const importAccountRoutes = new Hono()

interface ImportAccountPayload {
  id?: string
  label?: string
  provider?: string
  enabled?: boolean
  priority?: number
  serviceToken?: string
  xiaomichatbotPh?: string
  credentials?: Record<string, unknown>
  settings?: Record<string, unknown>
  createdAt?: number
}

// Import accounts from exported JSON
importAccountRoutes.post("/import", async (c) => {
  let body: { accounts?: Array<ImportAccountPayload>; overwrite?: boolean }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  if (!Array.isArray(body.accounts) || body.accounts.length === 0) {
    return c.json({ error: "No accounts provided in payload." }, 400)
  }

  const overwrite = body.overwrite === true
  const imported: Array<string> = []
  const skipped: Array<string> = []
  const failed: Array<{ label: string; reason: string }> = []

  for (const raw of body.accounts) {
    const label = raw.label ?? `imported-${imported.length + 1}`
    const providerStr = raw.provider ?? "copilot"
    const provider: AccountProvider =
      isProviderId(providerStr) ? providerStr : "copilot"

    // Check for existing account with matching label+provider
    const duplicateIndex = state.accounts.findIndex(
      (a) => a.label === label && a.provider === provider,
    )
    if (duplicateIndex !== -1) {
      if (!overwrite) {
        skipped.push(label)
        continue
      }
      // overwrite=true: remove existing account before importing new one
      const existing = state.accounts[duplicateIndex]
      cancelTokenRefreshTimer(existing.id)
      clearAccountRateLimitState(existing.id)
      state.accounts.splice(duplicateIndex, 1)
      // Fix activeAccountIndex after splice (mirrors delete handler)
      if (duplicateIndex < state.activeAccountIndex) {
        state.activeAccountIndex = Math.max(0, state.activeAccountIndex - 1)
      } else if (duplicateIndex === state.activeAccountIndex) {
        state.activeAccountIndex = Math.min(
          duplicateIndex,
          Math.max(0, state.accounts.length - 1),
        )
      }
    }

    if (provider === "copilot") {
      const githubToken =
        typeof raw.credentials?.githubToken === "string" ?
          raw.credentials.githubToken.trim()
        : undefined

      if (!githubToken) {
        failed.push({ label, reason: "Missing githubToken in credentials." })
        continue
      }

      const account: Account = {
        id: randomUUID(),
        label,
        provider: "copilot",
        credentials: { githubToken },
        settings: raw.settings ?? {},
        githubToken,
        enabled: raw.enabled ?? true,
        priority: raw.priority ?? 0,
        quotaState: "unknown",
        createdAt: raw.createdAt ?? Date.now(),
      }
      setGitHubToken(account, githubToken)
      addAccount(account)
      imported.push(label)

      // Refresh token in background
      refreshCopilotToken(account)
        .then(() => refreshQuotaForAccount(account))
        .then(() => refreshModelsForAccount(account))
        .catch((err: unknown) => {
          consola.warn(`Import: failed to init account "${label}":`, err)
        })
      continue
    }

    if (provider === "codebuff") {
      const authToken =
        typeof raw.credentials?.authToken === "string" ?
          raw.credentials.authToken.trim()
        : undefined

      if (!authToken) {
        failed.push({ label, reason: "Missing authToken in credentials." })
        continue
      }

      const account: Account = {
        id: randomUUID(),
        label,
        provider: "codebuff",
        credentials: { authToken },
        settings: raw.settings ?? {},
        codebuffAuthToken: authToken,
        enabled: raw.enabled ?? true,
        priority: raw.priority ?? 0,
        quotaState: "unknown",
        createdAt: raw.createdAt ?? Date.now(),
      }
      addAccount(account)
      imported.push(label)
      refreshModelsForAccount(account).catch((err: unknown) => {
        consola.warn(`Import: failed to init account "${label}":`, err)
      })
      continue
    }

    if (provider === "windsurf") {
      const apiKey =
        typeof raw.credentials?.apiKey === "string" ?
          raw.credentials.apiKey.trim()
        : undefined

      if (!apiKey) {
        failed.push({ label, reason: "Missing apiKey in credentials." })
        continue
      }

      const windsurfAccount: Account = {
        id: randomUUID(),
        label,
        provider: "windsurf",
        credentials: { apiKey },
        settings: raw.settings ?? {},
        windsurfApiKey: apiKey,
        enabled: raw.enabled ?? true,
        priority: raw.priority ?? 0,
        quotaState: "unknown",
        createdAt: raw.createdAt ?? Date.now(),
      }
      addAccount(windsurfAccount)
      imported.push(label)
      refreshModelsForAccount(windsurfAccount).catch((err: unknown) => {
        consola.warn(`Import: failed to init account "${label}":`, err)
      })
      continue
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (provider === "mimo-aistudio") {
      const serviceToken =
        typeof raw.credentials?.serviceToken === "string" ?
          raw.credentials.serviceToken.trim()
        : (raw.serviceToken?.trim()
          ?? (typeof raw.settings?.serviceToken === "string" ?
            raw.settings.serviceToken.trim()
          : undefined))
      const xiaomichatbotPh =
        typeof raw.credentials?.xiaomichatbotPh === "string" ?
          raw.credentials.xiaomichatbotPh.trim()
        : (raw.xiaomichatbotPh?.trim()
          ?? (typeof raw.settings?.xiaomichatbotPh === "string" ?
            raw.settings.xiaomichatbotPh.trim()
          : undefined))

      if (!serviceToken || !xiaomichatbotPh) {
        failed.push({
          label,
          reason: "Missing serviceToken or xiaomichatbotPh in credentials.",
        })
        continue
      }

      const settings = raw.settings ?? {}
      const mimoAccount: Account = {
        id: randomUUID(),
        label,
        provider: "mimo-aistudio",
        credentials: { serviceToken, xiaomichatbotPh },
        settings,
        serviceToken,
        xiaomichatbotPh,
        userId:
          typeof settings.userId === "string" ? settings.userId : undefined,
        proxy: typeof settings.proxy === "string" ? settings.proxy : undefined,
        enabled: raw.enabled ?? true,
        priority: raw.priority ?? 0,
        quotaState: "unknown",
        createdAt: raw.createdAt ?? Date.now(),
      }
      addAccount(mimoAccount)
      imported.push(label)
      refreshModelsForAccount(mimoAccount).catch((err: unknown) => {
        consola.warn(`Import: failed to init account "${label}":`, err)
      })
      continue
    }
  }

  if (imported.length > 0) {
    await saveAccounts()
    consola.info(
      `Imported ${imported.length} account(s): ${imported.join(", ")}`,
    )
  }

  return c.json({
    ok: true,
    imported: imported.length,
    skipped: skipped.length,
    failed: failed.length,
    details: { imported, skipped, failed },
  })
})
