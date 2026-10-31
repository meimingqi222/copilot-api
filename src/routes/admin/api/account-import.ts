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
import { PROVIDER_METADATA } from "~/lib/provider-metadata"
import { refreshQuotaForConnection } from "~/lib/quota/scheduler"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { readJsonBody } from "~/lib/request-body"
import { refreshModelsForConnection } from "~/lib/utils"
import { cookieHeader, parseCookieHeader } from "~/services/aistudio/auth"
import {
  cancelConnectionTokenRefresh,
  refreshCopilotTokenForConnection,
} from "~/services/copilot/token-refresh"
import { scheduleLobsteraiRefreshForAllConnections } from "~/services/lobsterai/token-refresh"
import { scheduleCodebuddyRefreshForAllConnections } from "~/services/codebuddy/token-refresh"
import {
  importCpaAuthRecords,
  parseCpaAuthPayload,
} from "~/services/oauth/cpa-import"
import { scheduleOAuthRefreshForConnection } from "~/services/oauth/refresh-scheduler"
import { initializeProviderRegistry } from "~/services/providers"
import { getBuiltinProviderModule } from "~/services/providers/builtins"
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

function buildAistudioAccount(
  raw: ImportAccountPayload,
  label: string,
): BuildResult {
  try {
    return {
      input: {
        ...baseAccountFields(raw, label, "aistudio"),
        credentials: {
          cookie: cookieHeader(
            parseCookieHeader(credentialString(raw, "cookie") ?? ""),
          ),
        },
        settings: raw.settings ?? {},
      },
    }
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Invalid AI Studio Cookie.",
    }
  }
}

/**
 * Deserialize a non-OAuth account from the provider descriptor: the primary
 * credential plus the context keys it declares. Providers whose import shape
 * needs legacy fallbacks or normalization keep a dedicated builder below.
 */
function buildDescriptorAccount(
  raw: ImportAccountPayload,
  label: string,
  provider: ProviderId,
): BuildResult {
  const schema = PROVIDER_METADATA[provider].credentials
  if (!schema) {
    return { error: `Unsupported provider: ${provider}.` }
  }
  const primary = credentialString(raw, schema.primaryKey)
  if (!primary) {
    return { error: `Missing ${schema.primaryKey} in credentials.` }
  }
  const credentials: Record<string, unknown> = {
    [schema.primaryKey]: primary,
  }
  for (const key of schema.contextStringKeys ?? []) {
    const value = credentialString(raw, key)
    if (value) credentials[key] = value
  }
  for (const key of schema.contextValueKeys ?? []) {
    const value = raw.credentials?.[key]
    if (typeof value === "number" && value) credentials[key] = value
  }
  return {
    input: {
      ...baseAccountFields(raw, label, provider),
      credentials,
      settings: raw.settings ?? {},
    },
  }
}

type AccountBuilder = (raw: ImportAccountPayload, label: string) => BuildResult

/** Provider-specific import shapes that the descriptor cannot express. */
const SPECIAL_PROVIDER_BUILDERS: Partial<Record<ProviderId, AccountBuilder>> = {
  aistudio: buildAistudioAccount,
  "mimo-aistudio": buildMimoAccount,
  lobsterai: buildLobsteraiAccount,
}

/** Dispatch to the provider-specific builder for a non-OAuth import row. */
function buildProviderAccount(
  raw: ImportAccountPayload,
  label: string,
  provider: ProviderId,
): BuildResult {
  const special = SPECIAL_PROVIDER_BUILDERS[provider]
  if (special) return special(raw, label)
  return buildDescriptorAccount(raw, label, provider)
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
  void Promise.resolve()
    .then(() => getBuiltinProviderModule(provider)?.afterAuthentication?.(conn))
    .then(() => refreshModelsForConnection(conn))
    .catch(warn)
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

/**
 * Read the provider-specific credential keys declared by the descriptor, so a
 * newly added OAuth provider survives export/import without another hardcoded
 * key list here. The OAuth generic keys stay in the caller.
 */
function pickDescriptorCredentialFields(
  raw: ImportAccountPayload,
  provider: ProviderId,
  pickString: (key: string) => string | undefined,
): Record<string, unknown> {
  const schema = PROVIDER_METADATA[provider].credentials
  const fields: Record<string, unknown> = {}
  for (const key of schema?.contextStringKeys ?? []) {
    fields[key] = pickString(key)
  }
  for (const key of schema?.contextValueKeys ?? []) {
    const value = raw.credentials?.[key]
    fields[key] =
      typeof value === "number" || typeof value === "string" ? value : undefined
  }
  return fields
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
      ...pickDescriptorCredentialFields(raw, provider, pickCredentialString),
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
  let body: {
    accounts?: Array<ImportAccountPayload>
    overwrite?: boolean
    restoreProxy?: boolean
  }
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

  for (const importedAccount of body.accounts) {
    // Proxies belong to the importing server. Preserve legacy API behavior unless
    // the caller explicitly chooses to use this server's current proxy settings.
    const raw = {
      ...importedAccount,
      settings: { ...importedAccount.settings },
    }
    if (body.restoreProxy === false) delete raw.settings.proxyUrl
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
      // Both providers refresh on a timer and both are importable here; only
      // scheduling one left the other's new accounts without a refresh until
      // the next restart.
      scheduleLobsteraiRefreshForAllConnections()
      scheduleCodebuddyRefreshForAllConnections()
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
