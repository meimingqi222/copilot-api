import consola from "consola"
import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import type { Account, AccountProvider, OAuthAccount } from "~/lib/accounts"

import {
  refreshCopilotToken,
  refreshQuotaForAccount,
  saveAccounts,
} from "~/lib/account-store"
import { cancelTokenRefreshTimer } from "~/lib/account-store"
import { setGitHubToken, addAccount } from "~/lib/accounts"
import { isOAuthProviderId, isProviderId } from "~/lib/provider-config"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { refreshModelsForAccount } from "~/lib/utils"
import {
  importCpaAuthRecords,
  parseCpaAuthPayload,
} from "~/services/oauth/cpa-import"
import { scheduleOAuthRefreshForAccount } from "~/services/oauth/refresh-scheduler"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

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
  cpaMetadata?: Record<string, unknown>
  createdAt?: number
}

function buildOAuthAccountFromImportPayload(
  raw: ImportAccountPayload,
  label: string,
  provider: OAuthAccount["provider"],
): OAuthAccount | null {
  const accessToken =
    typeof raw.credentials?.accessToken === "string" ?
      raw.credentials.accessToken.trim()
    : undefined
  const apiKey =
    typeof raw.credentials?.apiKey === "string" ?
      raw.credentials.apiKey.trim()
    : undefined

  if (!accessToken && !apiKey) {
    return null
  }

  const pickCredentialString = (key: string): string | undefined => {
    const value = raw.credentials?.[key]
    return typeof value === "string" ? value.trim() : undefined
  }

  const pickSettingString = (key: string): string | undefined => {
    const value = raw.settings?.[key]
    return typeof value === "string" ? value.trim() : undefined
  }

  return {
    id: randomUUID(),
    label,
    provider,
    enabled: raw.enabled ?? true,
    priority: raw.priority ?? 0,
    quotaState: "unknown",
    createdAt: raw.createdAt ?? Date.now(),
    credentials: {
      accessToken,
      apiKey,
      refreshToken: pickCredentialString("refreshToken"),
      idToken: pickCredentialString("idToken"),
      expiresAt:
        typeof raw.credentials?.expiresAt === "number" ?
          raw.credentials.expiresAt
        : undefined,
      accountId: pickCredentialString("accountId"),
      projectId: pickCredentialString("projectId"),
      deviceId: pickCredentialString("deviceId"),
      email: pickCredentialString("email"),
    },
    settings: {
      baseUrl: pickSettingString("baseUrl"),
      proxyUrl: pickSettingString("proxyUrl"),
      modelPrefix: pickSettingString("modelPrefix"),
      cpaSourcePath: pickSettingString("cpaSourcePath"),
      tokenEndpoint: pickSettingString("tokenEndpoint"),
      redirectUri: pickSettingString("redirectUri"),
    },
    cpaMetadata:
      raw.cpaMetadata && typeof raw.cpaMetadata === "object" ?
        raw.cpaMetadata
      : undefined,
    runtimeState: { authStatus: "ready" },
  }
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

  initializeProviderRegistry()

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

    if (isOAuthProviderId(provider)) {
      const oauthAccount = buildOAuthAccountFromImportPayload(
        raw,
        label,
        provider,
      )
      if (!oauthAccount) {
        failed.push({
          label,
          reason: "Missing accessToken or apiKey in credentials.",
        })
        continue
      }

      addAccount(oauthAccount)
      imported.push(label)

      scheduleOAuthRefreshForAccount(oauthAccount)
      refreshModelsForAccount(oauthAccount).catch((err: unknown) => {
        consola.warn(`Import: failed to init models for "${label}":`, err)
      })
      const runtime = getProviderRuntime(oauthAccount.provider)
      if (runtime.refreshQuota) {
        runtime.refreshQuota(oauthAccount).catch((err: unknown) => {
          consola.warn(`Import: failed to init quota for "${label}":`, err)
        })
      }
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

importAccountRoutes.post("/import-cpa", async (c) => {
  let body: { records?: unknown; overwrite?: boolean }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  try {
    const records = parseCpaAuthPayload(body.records)
    if (records.length === 0) {
      return c.json({ error: "No CPA auth records provided." }, 400)
    }

    const result = importCpaAuthRecords(records, {
      overwrite: body.overwrite === true,
      existingAccounts: state.accounts,
      onAccount: (account) => {
        scheduleOAuthRefreshForAccount(account)
        void refreshModelsForAccount(account).catch((err: unknown) => {
          consola.warn(
            `CPA import: failed to refresh models for "${account.label}":`,
            err,
          )
        })
        const runtime = getProviderRuntime(account.provider)
        if (runtime.refreshQuota) {
          void runtime.refreshQuota(account).catch((err: unknown) => {
            consola.warn(
              `CPA import: failed to refresh quota for "${account.label}":`,
              err,
            )
          })
        }
      },
    })

    if (result.imported.length > 0) {
      initializeProviderRegistry()
      await saveAccounts()
      consola.info(
        `Imported ${result.imported.length} CPA auth account(s): ${result.imported.join(", ")}`,
      )
    }

    return c.json({
      ok: true,
      imported: result.imported.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
      details: result,
    })
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to import CPA auth",
      },
      400,
    )
  }
})
