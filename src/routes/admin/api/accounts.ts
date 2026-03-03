import consola from "consola"
import { Hono } from "hono"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import type { Account } from "~/lib/accounts"

import {
  getActiveAccount,
  refreshCopilotToken,
  refreshQuotaForAccount,
  saveAccounts,
} from "~/lib/accounts"
import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"
import { getDeviceCode } from "~/services/github/get-device-code"

export const accountApiRoutes = new Hono()

// Persisted map of pending device-code flows: deviceCode → pollState
interface PollState {
  label: string
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
    const data = await fs.readFile(PATHS.PENDING_FLOWS_PATH)
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

// Sanitize account for API response (omit raw githubToken)
function publicAccount(account: Account) {
  const { githubToken: _token, ...rest } = account
  return rest
}

accountApiRoutes.get("/", (c) => {
  return c.json({
    accounts: state.accounts.map((account) => publicAccount(account)),
  })
})

accountApiRoutes.post("/", async (c) => {
  let body: { label?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const label = body.label ?? `account-${state.accounts.length + 1}`

  let deviceCodeResponse: Awaited<ReturnType<typeof getDeviceCode>>
  try {
    deviceCodeResponse = await getDeviceCode()
  } catch {
    return c.json({ error: "Failed to initiate GitHub device flow." }, 502)
  }

  const { device_code, user_code, verification_uri, expires_in, interval } =
    deviceCodeResponse

  pendingFlows.set(device_code, {
    label,
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
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: verification_uri,
    expiresIn: expires_in,
    interval,
  })
})

accountApiRoutes.post("/poll/:deviceCode", async (c) => {
  const deviceCode = c.req.param("deviceCode")
  const flow = pendingFlows.get(deviceCode)

  if (!flow) {
    return c.json({ error: "Unknown or expired device code." }, 404)
  }

  if (flow.status === "complete") {
    return c.json({ status: "complete", accountId: flow.accountId })
  }

  if (flow.status === "expired" || Date.now() > flow.expiresAt) {
    flow.status = "expired"
    await savePendingFlows()
    return c.json({ status: "expired" })
  }

  // Try to exchange device_code for access_token
  const response = await fetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
    method: "POST",
    headers: standardHeaders(),
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  })

  if (!response.ok) {
    consola.debug(`Poll device flow: GitHub returned ${response.status}`)
    return c.json({ status: "pending" })
  }

  let json: {
    access_token?: string
    error?: string
    error_description?: string
    interval?: number
  }
  try {
    json = await response.json()
    consola.debug("Poll device flow: GitHub response:", json)
  } catch (e) {
    consola.error("Poll device flow: Failed to parse GitHub response:", e)
    return c.json({ status: "pending" })
  }

  if (json.error === "authorization_pending") {
    return c.json({ status: "pending", interval: flow.interval })
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
    return c.json({ status: "pending", interval: newInterval })
  }

  if (json.error) {
    flow.status = "expired"
    await savePendingFlows()
    return c.json({ status: "expired" })
  }

  if (!json.access_token) {
    return c.json({ status: "pending" })
  }

  // Create account
  const account: Account = {
    id: randomUUID(),
    label: flow.label,
    githubToken: json.access_token,
    isActive: state.accounts.length === 0,
    isExhausted: false,
    createdAt: Date.now(),
  }

  state.accounts.push(account)
  await saveAccounts()

  // Refresh Copilot token and quota in background
  refreshCopilotToken(account)
    .then(() => refreshQuotaForAccount(account))
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
      cacheModels().catch((err: unknown) => {
        consola.warn("Failed to refresh models after adding account:", err)
      })
    }, 2000)
  }

  return c.json({ status: "complete", accountId: account.id })
})

accountApiRoutes.put("/:id", async (c) => {
  const id = c.req.param("id")
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  let body: { label?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  if (body.label) account.label = body.label
  await saveAccounts()
  return c.json({ account: publicAccount(account) })
})

accountApiRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const idx = state.accounts.findIndex((a) => a.id === id)
  if (idx === -1) return c.json({ error: "Account not found." }, 404)

  state.accounts.splice(idx, 1)
  // Fix active index if needed
  if (state.activeAccountIndex >= state.accounts.length) {
    state.activeAccountIndex = Math.max(0, state.accounts.length - 1)
  }
  await saveAccounts()
  return c.json({ ok: true })
})

// Force-refresh Copilot token for an account
accountApiRoutes.post("/:id/refresh", async (c) => {
  const id = c.req.param("id")
  const account = state.accounts.find((a) => a.id === id)
  if (!account) return c.json({ error: "Account not found." }, 404)

  try {
    await refreshCopilotToken(account)
    return c.json({ account: publicAccount(account) })
  } catch {
    return c.json({ error: "Failed to refresh Copilot token." }, 502)
  }
})

// Set active account
accountApiRoutes.post("/:id/activate", (c) => {
  const id = c.req.param("id")
  const idx = state.accounts.findIndex((a) => a.id === id)
  if (idx === -1) return c.json({ error: "Account not found." }, 404)

  state.activeAccountIndex = idx
  try {
    getActiveAccount() // validate not exhausted
  } catch {
    return c.json({ error: "Account is exhausted." }, 409)
  }
  return c.json({ ok: true, activeAccountIndex: idx })
})
