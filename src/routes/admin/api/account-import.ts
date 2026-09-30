import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import type {
  ManagedConnectionInput,
  ProviderConnection,
} from "~/lib/provider-connections"

import { logger } from "~/lib/logger"
import {
  isOAuthProviderId,
  isProviderId,
  type ProviderId,
} from "~/lib/provider-config"
import {
  accountManagedProvider,
  listAccountManagedConnections,
  managedConnectionFromInput,
  persistProviderConnections,
  removeProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { refreshQuotaForConnection } from "~/lib/quota/scheduler"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { readJsonBody } from "~/lib/request-body"
import { refreshModelsForConnection } from "~/lib/utils"
import { scheduleCodebuddyRefresh } from "~/services/codebuddy/token-refresh"
import {
  cancelConnectionTokenRefresh,
  refreshCopilotTokenForConnection,
} from "~/services/copilot/token-refresh"
import {
  scheduleLobsteraiRefresh,
  scheduleLobsteraiRefreshForAllConnections,
} from "~/services/lobsterai/token-refresh"
import {
  importCpaAuthRecords,
  parseCpaAuthPayload,
} from "~/services/oauth/cpa-import"
import { scheduleOAuthRefreshForConnection } from "~/services/oauth/refresh-scheduler"
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

/** A provider branch either yields a connection input or a failure reason. */
type BuildResult = { input: ManagedConnectionInput } | { error: string }

function credentialString(
  raw: ImportAccountPayload,
  key: string,
): string | undefined {
  const value = raw.credentials?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function baseAccountFields(
  raw: ImportAccountPayload,
  label: string,
  provider: ProviderId,
): Pick<
  ManagedConnectionInput,
  "id" | "name" | "provider" | "enabled" | "priority" | "createdAt"
> {
  return {
    id: randomUUID(),
    name: label,
    provider,
    enabled: raw.enabled ?? true,
    priority: raw.priority ?? 0,
    createdAt: raw.createdAt ?? Date.now(),
  }
}

function buildCopilotAccount(
  raw: ImportAccountPayload,
  label: string,
): BuildResult {
  const githubToken = credentialString(raw, "githubToken")
  if (!githubToken) {
    return { error: "Missing githubToken in credentials." }
  }
  return {
    input: {
      ...baseAccountFields(raw, label, "copilot"),
      credentials: { githubToken },
      settings: raw.settings ?? {},
    },
  }
}

function buildCodebuffAccount(
  raw: ImportAccountPayload,
  label: string,
): BuildResult {
  const authToken = credentialString(raw, "authToken")
  if (!authToken) {
    return { error: "Missing authToken in credentials." }
  }
  return {
    input: {
      ...baseAccountFields(raw, label, "codebuff"),
      credentials: { authToken },
      settings: raw.settings ?? {},
    },
  }
}

function buildWindsurfAccount(
  raw: ImportAccountPayload,
  label: string,
): BuildResult {
  const apiKey = credentialString(raw, "apiKey")
  if (!apiKey) {
    return { error: "Missing apiKey in credentials." }
  }
  return {
    input: {
      ...baseAccountFields(raw, label, "windsurf"),
      credentials: { apiKey },
      settings: raw.settings ?? {},
    },
  }
}

function buildMimoAccount(
  raw: ImportAccountPayload,
  label: string,
): BuildResult {
  // Match the original ternaries exactly: a string `credentials.serviceToken`
  // that trims to "" does NOT fall through to the top-level/settings spelling.
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
    return { error: "Missing serviceToken or xiaomichatbotPh in credentials." }
  }
  return {
    input: {
      ...baseAccountFields(raw, label, "mimo-aistudio"),
      credentials: { serviceToken, xiaomichatbotPh },
      settings: raw.settings ?? {},
    },
  }
}

function buildCodebuddyAccount(
  raw: ImportAccountPayload,
  label: string,
  provider: "codebuddy" | "codebuddy-cn",
): BuildResult {
  const accessToken = credentialString(raw, "accessToken")
  if (!accessToken) {
    return { error: "Missing accessToken in credentials." }
  }
  const refreshToken = credentialString(raw, "refreshToken")
  const expiresAt =
    typeof raw.credentials?.expiresAt === "number" ?
      raw.credentials.expiresAt
    : undefined
  return {
    input: {
      ...baseAccountFields(raw, label, provider),
      credentials: {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
      settings: raw.settings ?? {},
    },
  }
}

function buildLobsteraiAccount(
  raw: ImportAccountPayload,
  label: string,
): BuildResult {
  const accessToken = credentialString(raw, "accessToken")
  const refreshToken = credentialString(raw, "refreshToken")
  if (!accessToken && !refreshToken) {
    return { error: "Missing accessToken or refreshToken in credentials." }
  }
  const expiresAt =
    typeof raw.credentials?.expiresAt === "number" ?
      raw.credentials.expiresAt
    : undefined
  const optional = (key: string) => {
    const value = credentialString(raw, key)
    return value ? { [key]: value } : {}
  }
  return {
    input: {
      ...baseAccountFields(raw, label, "lobsterai"),
      credentials: {
        accessToken: accessToken ?? "",
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...optional("uuid"),
        ...optional("userId"),
        ...optional("firstKeyfrom"),
        ...optional("latestKeyfrom"),
      },
      settings: raw.settings ?? {},
    },
  }
}

/** Dispatch to the provider-specific builder for a non-OAuth import row. */
function buildProviderAccount(
  raw: ImportAccountPayload,
  label: string,
  provider: ProviderId,
): BuildResult {
  switch (provider) {
    case "copilot": {
      return buildCopilotAccount(raw, label)
    }
    case "codebuff": {
      return buildCodebuffAccount(raw, label)
    }
    case "windsurf": {
      return buildWindsurfAccount(raw, label)
    }
    case "mimo-aistudio": {
      return buildMimoAccount(raw, label)
    }
    case "codebuddy":
    case "codebuddy-cn": {
      return buildCodebuddyAccount(raw, label, provider)
    }
    case "lobsterai": {
      return buildLobsteraiAccount(raw, label)
    }
    default: {
      return { error: `Unsupported provider: ${provider}.` }
    }
  }
}

/**
 * Kick off post-add initialization for an imported non-OAuth connection:
 * provider-specific timers plus best-effort model discovery. Copilot refresh
 * chains its quota fetch after the token refresh; every other provider only
 * refreshes models. The warning wording differs per provider and is preserved
 * from the original per-branch implementations.
 */
function initializeImportedAccount(
  conn: ProviderConnection,
  label: string,
  provider: ProviderId,
): void {
  const usesModelsWording =
    provider === "codebuddy"
    || provider === "codebuddy-cn"
    || provider === "lobsterai"
  const warn = (err: unknown) => {
    logger.warn(
      usesModelsWording ?
        `Import: failed to init models for "${label}":`
      : `Import: failed to init account "${label}":`,
      err,
    )
  }
  if (provider === "copilot") {
    refreshCopilotTokenForConnection(conn)
      .then(() => refreshQuotaForConnection(conn))
      .then(() => refreshModelsForConnection(conn))
      .catch(warn)
    return
  }
  if (provider === "codebuddy" || provider === "codebuddy-cn") {
    scheduleCodebuddyRefresh(conn)
  }
  if (provider === "lobsterai") {
    scheduleLobsteraiRefresh(conn)
  }
  void refreshModelsForConnection(conn).catch(warn)
}

/** OAuth import: schedule refresh, discover models, and fetch quota if the runtime supports it. */
function initializeOAuthAccount(conn: ProviderConnection, label: string): void {
  const warn = (err: unknown) => {
    logger.warn(`Import: failed to init account "${label}":`, err)
  }
  scheduleOAuthRefreshForConnection(conn)
  void refreshModelsForConnection(conn).catch(warn)
  const runtime = getProviderRuntime(accountManagedProvider(conn))
  if (runtime.refreshQuota) {
    runtime.refreshQuota(conn).catch((err: unknown) => {
      logger.warn(`Import: failed to init quota for "${label}":`, err)
    })
  }
}

function buildOAuthAccountFromImportPayload(
  raw: ImportAccountPayload,
  label: string,
  provider: ProviderId,
): ManagedConnectionInput | null {
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
    name: label,
    provider,
    enabled: raw.enabled ?? true,
    priority: raw.priority ?? 0,
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
  }
}

// Import accounts from exported JSON
importAccountRoutes.post("/import", async (c) => {
  let body: { accounts?: Array<ImportAccountPayload>; overwrite?: boolean }
  try {
    body = await readJsonBody(c.req.raw)
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
    const provider: ProviderId =
      isProviderId(providerStr) ? providerStr : "copilot"

    // 检查是否存在同 label+provider 的 connection
    const duplicate = listAccountManagedConnections().find((conn) => {
      const connProvider = accountManagedProvider(conn)
      return conn.name === label && connProvider === provider
    })
    if (duplicate) {
      if (!overwrite) {
        skipped.push(label)
        continue
      }
      // overwrite=true: remove existing account before importing new one
      cancelConnectionTokenRefresh(duplicate.id)
      clearAccountRateLimitState(duplicate.id)
      removeProviderConnection(duplicate.id)
    }

    if (isOAuthProviderId(provider)) {
      const oauthInput = buildOAuthAccountFromImportPayload(
        raw,
        label,
        provider,
      )
      if (!oauthInput) {
        failed.push({
          label,
          reason: "Missing accessToken or apiKey in credentials.",
        })
        continue
      }

      const conn = managedConnectionFromInput(oauthInput)
      upsertProviderConnection(conn)
      imported.push(label)
      initializeOAuthAccount(conn, label)
      continue
    }

    const result = buildProviderAccount(raw, label, provider)
    if ("error" in result) {
      failed.push({ label, reason: result.error })
      continue
    }

    const conn = managedConnectionFromInput(result.input)
    upsertProviderConnection(conn)
    imported.push(label)
    initializeImportedAccount(conn, label, provider)
  }

  if (imported.length > 0) {
    await persistProviderConnections()
    logger.info(
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
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  try {
    const records = parseCpaAuthPayload(body.records)
    if (records.length === 0) {
      return c.json({ error: "No CPA auth records provided." }, 400)
    }

    // CPA 导入:使用 connection 原生列表进行重复检测
    const existingConnections = listAccountManagedConnections()
    const result = importCpaAuthRecords(records, {
      overwrite: body.overwrite === true,
      existingConnections,
      onAccount: (conn) => {
        scheduleOAuthRefreshForConnection(conn)
        void refreshModelsForConnection(conn).catch((err: unknown) => {
          logger.warn(
            `CPA import: failed to refresh models for "${conn.name}":`,
            err,
          )
        })
        const provider = accountManagedProvider(conn)
        const runtime = getProviderRuntime(provider)
        if (runtime.refreshQuota) {
          void runtime.refreshQuota(conn).catch((err: unknown) => {
            logger.warn(
              `CPA import: failed to refresh quota for "${conn.name}":`,
              err,
            )
          })
        }
      },
    })

    if (result.imported.length > 0) {
      initializeProviderRegistry()
      await persistProviderConnections()
      scheduleLobsteraiRefreshForAllConnections()
      logger.info(
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
