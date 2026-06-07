/* eslint-disable max-lines */
import consola from "consola"
import { Hono } from "hono"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import type { Account, AccountProvider } from "~/lib/accounts"

import { getAccountAvailability } from "~/lib/account-availability"
import { switchToNextAccount } from "~/lib/account-selection"
import {
  cancelTokenRefreshTimer,
  refreshCopilotToken,
  refreshQuotaForAccount,
  saveAccounts,
  serializeAccountForExport,
} from "~/lib/account-store"
import {
  getCodebuffAuthToken,
  getGitHubToken,
  getWindsurfApiKey,
  getMimoServiceToken,
  getMimoPh,
  setCodebuffAuthToken,
  setGitHubToken,
  setWindsurfApiKey,
  setMimoServiceToken,
  setMimoPh,
  setMimoProxy,
  setMimoUserId,
  addAccount,
} from "~/lib/accounts"
import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { PATHS } from "~/lib/paths"
import { isProviderId } from "~/lib/provider-config"
import { clearAccountRateLimitState } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { cacheModels, refreshModelsForAccount } from "~/lib/utils"
import { getDeviceCode } from "~/services/github/get-device-code"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

function getHasCredentials(account: Account): boolean {
  if (account.provider === "copilot") {
    return Boolean(getGitHubToken(account))
  }
  if (account.provider === "codebuff") {
    return Boolean(getCodebuffAuthToken(account))
  }
  if (account.provider === "windsurf") {
    return Boolean(getWindsurfApiKey(account))
  }
  return Boolean(getMimoServiceToken(account) && getMimoPh(account))
}

// eslint-disable-next-line complexity
async function updateProviderAccount(
  account: Account,
  body: {
    label?: string
    enabled?: boolean
    priority?: number
    authToken?: string
    apiKey?: string
    serviceToken?: string
    xiaomichatbotPh?: string
    credentials?: Record<string, unknown>
    settings?: Record<string, unknown>
  },
): Promise<void> {
  if (account.provider === "codebuff") {
    const authToken =
      typeof body.credentials?.authToken === "string" ?
        body.credentials.authToken
      : body.authToken
    if (
      Object.hasOwn(body, "authToken")
      || Object.hasOwn(body.credentials ?? {}, "authToken")
    ) {
      setCodebuffAuthToken(account, authToken?.trim() || undefined)
    }
    account.settings = {
      ...account.settings,
      ...body.settings,
    }
    const settings = account.settings
    account.codebuffBaseUrl =
      typeof settings.baseUrl === "string" ?
        settings.baseUrl
      : account.codebuffBaseUrl
    account.codebuffCliVersion =
      typeof settings.cliVersion === "string" ?
        settings.cliVersion
      : account.codebuffCliVersion
    account.codebuffAgentId =
      typeof settings.agentId === "string" ?
        settings.agentId
      : account.codebuffAgentId
    account.codebuffModel =
      typeof settings.model === "string" ?
        settings.model
      : account.codebuffModel
    account.codebuffCostMode =
      typeof settings.costMode === "string" ?
        settings.costMode
      : account.codebuffCostMode
    account.codebuffAllowFallbacks =
      typeof settings.allowFallbacks === "boolean" ?
        settings.allowFallbacks
      : account.codebuffAllowFallbacks
    await refreshModelsForAccount(account)
    return
  }

  if (account.provider === "windsurf") {
    const apiKey =
      typeof body.credentials?.apiKey === "string" ?
        body.credentials.apiKey
      : body.apiKey
    if (
      Object.hasOwn(body, "apiKey")
      || Object.hasOwn(body.credentials ?? {}, "apiKey")
    ) {
      setWindsurfApiKey(account, apiKey?.trim() || undefined)
    }
    account.settings = {
      ...account.settings,
      ...body.settings,
    }
    const settings = account.settings
    account.windsurfBaseUrl =
      typeof settings.baseUrl === "string" ?
        settings.baseUrl
      : account.windsurfBaseUrl
    account.windsurfAppVersion =
      typeof settings.appVersion === "string" ?
        settings.appVersion
      : account.windsurfAppVersion
    account.windsurfLsVersion =
      typeof settings.lsVersion === "string" ?
        settings.lsVersion
      : account.windsurfLsVersion
    account.windsurfDefaultModel =
      typeof settings.defaultModel === "string" ?
        settings.defaultModel
      : account.windsurfDefaultModel
    account.windsurfClientName =
      typeof settings.clientName === "string" ?
        settings.clientName
      : account.windsurfClientName
    await refreshModelsForAccount(account)
  }

  if (account.provider === "mimo-aistudio") {
    const serviceToken =
      typeof body.credentials?.serviceToken === "string" ?
        body.credentials.serviceToken
      : (body.serviceToken
        ?? (typeof body.settings?.serviceToken === "string" ?
          body.settings.serviceToken
        : undefined))
    const xiaomichatbotPh =
      typeof body.credentials?.xiaomichatbotPh === "string" ?
        body.credentials.xiaomichatbotPh
      : (body.xiaomichatbotPh
        ?? (typeof body.settings?.xiaomichatbotPh === "string" ?
          body.settings.xiaomichatbotPh
        : undefined))

    if (
      Object.hasOwn(body, "serviceToken")
      || Object.hasOwn(body.credentials ?? {}, "serviceToken")
      || Object.hasOwn(body.settings ?? {}, "serviceToken")
    ) {
      setMimoServiceToken(account, serviceToken?.trim() || undefined)
    }
    if (
      Object.hasOwn(body, "xiaomichatbotPh")
      || Object.hasOwn(body.credentials ?? {}, "xiaomichatbotPh")
      || Object.hasOwn(body.settings ?? {}, "xiaomichatbotPh")
    ) {
      setMimoPh(account, xiaomichatbotPh?.trim() || undefined)
    }

    account.settings = {
      ...account.settings,
      ...body.settings,
    }
    const settings = account.settings
    const userId =
      typeof settings.userId === "string" ? settings.userId : undefined
    setMimoUserId(account, userId?.trim() || undefined)

    if (Object.hasOwn(body.settings ?? {}, "proxy")) {
      const proxy =
        typeof settings.proxy === "string" ? settings.proxy : undefined
      setMimoProxy(account, proxy?.trim() || undefined)
    }

    await refreshModelsForAccount(account)
  }
}

export const accountApiRoutes = new Hono()
export const accountFlowApiRoutes = new Hono()

// Persisted map of pending device-code flows: deviceCode → pollState
interface PollState {
  label: string
  provider: AccountProvider
  interval: number
  expiresAt: number
  status: "pending" | "complete" | "expired"
  accountId?: string
}

// In-memory cache, loaded from disk on startup
const pendingFlows = new Map<string, PollState>()

// Load pending flows from disk
async function loadPendingFlows(): Promise<void> {
  try {
    // eslint-disable-next-line unicorn/prefer-json-parse-buffer
    const data = await fs.readFile(PATHS.PENDING_FLOWS_PATH, "utf8")
    const parsed = JSON.parse(data) as Record<string, PollState>
    for (const [key, value] of Object.entries(parsed)) {
      // Only restore non-expired flows
      if (value.expiresAt > Date.now()) {
        pendingFlows.set(key, value)
      }
    }
    consola.debug("Loaded pending device flows:", pendingFlows.size)
  } catch {
    // File doesn't exist or is invalid, start with empty map
  }
}

// Save pending flows to disk
async function savePendingFlows(): Promise<void> {
  const obj = Object.fromEntries(pendingFlows.entries())
  await fs.writeFile(PATHS.PENDING_FLOWS_PATH, JSON.stringify(obj, null, 2))
}

// Initialize on module load
void loadPendingFlows()

// Sanitize account for API response (omit sensitive tokens, compute isActive dynamically)
function publicAccount(account: Account) {
  initializeProviderRegistry()
  const runtime = getProviderRuntime(account.provider)
  const availability = getAccountAvailability(account)
  return {
    id: account.id,
    label: account.label,
    provider: account.provider,
    availableModels: account.availableModels,
    enabled: account.enabled,
    priority: account.priority,
    isExhausted:
      availability.reason === "cooldown" || availability.reason === "quota",
    exhaustedAt: account.exhaustedAt,
    availabilityReason: availability.reason,
    retryAfterSeconds: availability.retryAfterSeconds || null,
    quotaState: account.quotaState ?? "unknown",
    createdAt: account.createdAt,
    settings: account.settings ?? {},
    providerFeatures: runtime.descriptor.features,
    authStatus: account.runtimeState?.authStatus ?? "ready",
    authError: account.runtimeState?.lastError ?? null,
    hasCredentials: getHasCredentials(account),
    isActive: state.accounts.indexOf(account) === state.activeAccountIndex,
  }
}

accountApiRoutes.get("/", (c) => {
  return c.json({
    accounts: state.accounts.map((account) => publicAccount(account)),
  })
})

accountApiRoutes.post("/", async (c) => {
  initializeProviderRegistry()
  let body: {
    label?: string
    provider?: AccountProvider
    authToken?: string
    apiKey?: string
    serviceToken?: string
    xiaomichatbotPh?: string
    credentials?: Record<string, unknown>
    settings?: Record<string, unknown>
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const provider =
    isProviderId(String(body.provider)) ? body.provider : "copilot"
  const label = body.label ?? `account-${state.accounts.length + 1}`

  if (provider === "codebuff") {
    const authToken =
      typeof body.credentials?.authToken === "string" ?
        body.credentials.authToken.trim()
      : body.authToken?.trim()
    if (!authToken) {
      return c.json({ error: "Codebuff auth token is required." }, 400)
    }

    const account: Account = {
      id: randomUUID(),
      label,
      provider,
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        authToken,
      },
      settings: {
        ...body.settings,
      },
      codebuffAuthToken: authToken,
    }

    addAccount(account)
    await refreshModelsForAccount(account)
    await saveAccounts()

    return c.json({
      status: "complete",
      accountId: account.id,
      account: publicAccount(account),
    })
  }

  if (provider === "windsurf") {
    const apiKey =
      typeof body.credentials?.apiKey === "string" ?
        body.credentials.apiKey.trim()
      : body.apiKey?.trim()
    if (!apiKey) {
      return c.json({ error: "Windsurf API key is required." }, 400)
    }

    const account: Account = {
      id: randomUUID(),
      label,
      provider,
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        apiKey,
      },
      settings: {
        ...body.settings,
      },
      windsurfApiKey: apiKey,
    }

    addAccount(account)
    await refreshModelsForAccount(account)
    await saveAccounts()

    return c.json({
      status: "complete",
      accountId: account.id,
      account: publicAccount(account),
    })
  }

  if (provider === "mimo-aistudio") {
    const serviceToken =
      typeof body.credentials?.serviceToken === "string" ?
        body.credentials.serviceToken.trim()
      : (body.serviceToken?.trim()
        ?? (typeof body.settings?.serviceToken === "string" ?
          body.settings.serviceToken.trim()
        : undefined))
    const xiaomichatbotPh =
      typeof body.credentials?.xiaomichatbotPh === "string" ?
        body.credentials.xiaomichatbotPh.trim()
      : (body.xiaomichatbotPh?.trim()
        ?? (typeof body.settings?.xiaomichatbotPh === "string" ?
          body.settings.xiaomichatbotPh.trim()
        : undefined))

    if (!serviceToken || !xiaomichatbotPh) {
      return c.json({ error: "Service Token and PH cookie are required." }, 400)
    }

    const settings = body.settings ?? {}
    const account: Account = {
      id: randomUUID(),
      label,
      provider,
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        serviceToken,
        xiaomichatbotPh,
      },
      settings,
      serviceToken,
      xiaomichatbotPh,
      userId: typeof settings.userId === "string" ? settings.userId : undefined,
      proxy: typeof settings.proxy === "string" ? settings.proxy : undefined,
    }

    addAccount(account)
    await refreshModelsForAccount(account)
    await saveAccounts()

    return c.json({
      status: "complete",
      accountId: account.id,
      account: publicAccount(account),
    })
  }

  let deviceCodeResponse: Awaited<ReturnType<typeof getDeviceCode>>
  try {
    deviceCodeResponse = await getDeviceCode()
  } catch (e: unknown) {
    consola.error("Failed to initiate GitHub device flow:", e)
    return c.json({ error: "Failed to initiate GitHub device flow." }, 502)
  }

  const { device_code, user_code, verification_uri, expires_in, interval } =
    deviceCodeResponse

  pendingFlows.set(device_code, {
    label,
    provider: "copilot",
    interval,
    expiresAt: Date.now() + expires_in * 1000,
    status: "pending",
  })
  await savePendingFlows()

  // Clean up expired flows after expiry
  setTimeout(async () => {
    const flow = pendingFlows.get(device_code)
    if (flow && flow.status === "pending") {
      flow.status = "expired"
      await savePendingFlows()
    }
    setTimeout(async () => {
      pendingFlows.delete(device_code)
      await savePendingFlows()
    }, 60_000)
  }, expires_in * 1000)

  return c.json({
    flowId: device_code,
    status: "pending_auth",
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: verification_uri,
    expiresIn: expires_in,
    interval,
  })
})

async function pollAccountFlow(flowId: string): Promise<{
  status: string
  accountId?: string
  interval?: number
  error?: string
}> {
  const flow = pendingFlows.get(flowId)

  if (!flow) {
    return { status: "error", error: "Unknown or expired flow." }
  }

  if (flow.status === "complete") {
    return { status: "complete", accountId: flow.accountId }
  }

  if (flow.status === "expired" || Date.now() > flow.expiresAt) {
    flow.status = "expired"
    await savePendingFlows()
    return { status: "expired" }
  }

  // Try to exchange device_code for access_token
  const response = await fetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
    method: "POST",
    headers: standardHeaders(),
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: flowId,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  })

  if (!response.ok) {
    consola.debug(`Poll device flow: GitHub returned ${response.status}`)
    return { status: "pending" }
  }

  let json: {
    access_token?: string
    error?: string
    error_description?: string
    interval?: number
  }
  try {
    json = (await response.json()) as typeof json
    consola.debug("Poll device flow: GitHub response:", json)
  } catch (e) {
    consola.error("Poll device flow: Failed to parse GitHub response:", e)
    return { status: "pending" }
  }

  if (json.error === "authorization_pending") {
    return { status: "pending", interval: flow.interval }
  }

  if (json.error === "slow_down") {
    // GitHub is asking us to slow down — increase interval
    const newInterval =
      typeof json.interval === "number" ? json.interval : flow.interval + 5
    flow.interval = newInterval
    await savePendingFlows()
    consola.debug(
      `Poll device flow: slow_down received, increasing interval to ${newInterval}s`,
    )
    return { status: "pending", interval: newInterval }
  }

  if (json.error) {
    flow.status = "expired"
    await savePendingFlows()
    return { status: "expired" }
  }

  if (!json.access_token) {
    return { status: "pending" }
  }

  // Create account
  const account: Account = {
    id: randomUUID(),
    label: flow.label,
    provider: "copilot",
    credentials: {
      githubToken: json.access_token,
    },
    settings: {},
    githubToken: json.access_token,
    enabled: true,
    priority: 0,
    quotaState: "unknown",
    createdAt: Date.now(),
  }

  addAccount(account)
  await saveAccounts()

  // Refresh Copilot token and quota in background
  refreshCopilotToken(account)
    .then(() => refreshQuotaForAccount(account))
    .then(() => refreshModelsForAccount(account))
    .then(() => {
      consola.info(`GitHub account added: ${account.label}`)
    })
    .catch((err: unknown) => {
      consola.warn(`Failed to initialize account "${account.label}":`, err)
    })

  flow.status = "complete"
  flow.accountId = account.id
  await savePendingFlows()

  // Refresh models cache if this is the first account
  if (state.accounts.length === 1) {
    consola.info("First account added — refreshing models cache")
    // Wait a bit for copilot token to be ready
    setTimeout(() => {
      try {
        cacheModels()
      } catch (err: unknown) {
        consola.warn("Failed to refresh models after adding account:", err)
      }
    }, 2000)
  }

  return { status: "complete", accountId: account.id }
}

accountApiRoutes.post("/poll/:deviceCode", async (c) => {
  const result = await pollAccountFlow(c.req.param("deviceCode"))
  if (result.error) {
    return c.json({ error: result.error }, 404)
  }
  return c.json(result)
})

accountFlowApiRoutes.post("/:flowId/poll", async (c) => {
  const result = await pollAccountFlow(c.req.param("flowId"))
  if (result.error) {
    return c.json({ error: result.error }, 404)
  }
  return c.json(result)
})

accountApiRoutes.put("/:id", async (c) => {
  const id = c.req.param("id")
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  let body: {
    label?: string
    enabled?: boolean
    priority?: number
    authToken?: string
    apiKey?: string
    credentials?: Record<string, unknown>
    settings?: Record<string, unknown>
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  if (body.label) account.label = body.label
  if (typeof body.enabled === "boolean") {
    account.enabled = body.enabled
    if (!account.enabled) {
      cancelTokenRefreshTimer(account.id)
    }
    consola.info(
      `Account "${account.label}" ${account.enabled ? "enabled" : "disabled"}`,
    )
  }
  if (typeof body.priority === "number") {
    account.priority = Math.max(0, Math.min(100, body.priority))
    consola.info(
      `Account "${account.label}" priority set to ${account.priority}`,
    )
  }

  await updateProviderAccount(account, body)

  await saveAccounts()
  cacheModels()
  return c.json({ account: publicAccount(account) })
})

accountApiRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const idx = state.accounts.findIndex((a) => a.id === id)
  if (idx === -1) return c.json({ error: "Account not found." }, 404)

  // Cancel any pending token refresh timer to prevent leaks
  cancelTokenRefreshTimer(id)

  // Clear rate limit state for this account
  clearAccountRateLimitState(id)

  const wasActive = idx === state.activeAccountIndex
  state.accounts.splice(idx, 1)
  // Fix active index after deletion
  if (idx < state.activeAccountIndex) {
    // Deleted an account before the active one — shift index down
    state.activeAccountIndex = Math.max(0, state.activeAccountIndex - 1)
  } else if (wasActive) {
    // Deleted the active account itself — clamp then find next available
    state.activeAccountIndex = Math.min(
      idx,
      Math.max(0, state.accounts.length - 1),
    )
    switchToNextAccount()
  } else if (state.activeAccountIndex >= state.accounts.length) {
    state.activeAccountIndex = Math.max(0, state.accounts.length - 1)
  }
  await saveAccounts()
  return c.json({ ok: true })
})

accountApiRoutes.post("/:id/refresh", async (c) => {
  initializeProviderRegistry()
  const id = c.req.param("id")
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  try {
    const runtime = getProviderRuntime(account.provider)
    if (runtime.refreshAuth) {
      await runtime.refreshAuth(account)
    }

    await refreshModelsForAccount(account)
    if (runtime.refreshQuota) {
      await runtime.refreshQuota(account)
    } else if (account.provider === "copilot") {
      await refreshQuotaForAccount(account)
    }
    await saveAccounts()
    cacheModels()
    return c.json({ account: publicAccount(account) })
  } catch (e: unknown) {
    consola.error("Failed to refresh account:", e)
    return c.json({ error: "Failed to refresh account." }, 502)
  }
})

// Set account priority (formerly "activate" - now sets highest priority)
accountApiRoutes.post("/:id/activate", async (c) => {
  const id = c.req.param("id")
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  if (!account.enabled) {
    return c.json({ error: "Account is disabled." }, 409)
  }

  // Find minimum priority among all accounts
  const minPriority = Math.min(...state.accounts.map((a) => a.priority))
  // Set this account to highest priority (lower than current minimum)
  account.priority = Math.max(0, minPriority - 1)
  await saveAccounts()

  consola.info(
    `Account "${account.label}" set to highest priority (${account.priority})`,
  )

  return c.json({
    ok: true,
    account: publicAccount(account),
  })
})

// Export all accounts (includes credentials)
accountApiRoutes.get("/export", (c) => {
  const exported = state.accounts.map((account) =>
    serializeAccountForExport(account),
  )
  const filename = `copilot-api-accounts-${new Date().toISOString().slice(0, 10)}.json`
  c.header("Content-Disposition", `attachment; filename="${filename}"`)
  c.header("Content-Type", "application/json")
  return c.body(JSON.stringify({ accounts: exported }, null, 2))
})

// Export a single account (includes credentials)
accountApiRoutes.get("/:id/export", (c) => {
  const id = c.req.param("id")
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  const exported = serializeAccountForExport(account)
  const safeName = account.label.replaceAll(/[^\w-]/g, "_")
  const filename = `copilot-api-account-${safeName}-${new Date().toISOString().slice(0, 10)}.json`
  c.header("Content-Disposition", `attachment; filename="${filename}"`)
  c.header("Content-Type", "application/json")
  return c.body(JSON.stringify({ accounts: [exported] }, null, 2))
})

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
accountApiRoutes.post("/import", async (c) => {
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
