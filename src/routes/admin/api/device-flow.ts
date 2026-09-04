import { Hono } from "hono"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import type { Account, AccountProvider } from "~/lib/legacy-accounts"

import {
  refreshCopilotToken,
  refreshQuotaForAccount,
  saveAccounts,
} from "~/lib/account-store"
import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { addAccount } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import { assertWritableDataPath, PATHS } from "~/lib/paths"
import { refreshModelsForAccount } from "~/lib/utils"

// Persisted map of pending device-code flows: deviceCode → pollState
export interface PollState {
  label: string
  provider: AccountProvider
  interval: number
  expiresAt: number
  status: "pending" | "complete" | "expired"
  accountId?: string
}

// In-memory cache, loaded from disk on startup
const pendingFlows = new Map<string, PollState>()
const MAX_PENDING_DEVICE_FLOWS = 256

// Load pending flows from disk
export async function loadPendingFlows(): Promise<void> {
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
    logger.debug("Loaded pending device flows:", pendingFlows.size)
  } catch {
    // File doesn't exist or is invalid, start with empty map
  }
}

// Save pending flows to disk
export async function savePendingFlows(): Promise<void> {
  assertWritableDataPath(PATHS.PENDING_FLOWS_PATH)
  const obj = Object.fromEntries(pendingFlows.entries())
  await fs.writeFile(PATHS.PENDING_FLOWS_PATH, JSON.stringify(obj, null, 2))
}

// Initialize on module load
void loadPendingFlows()

export function registerPendingFlow(
  deviceCode: string,
  state: PollState,
): void {
  const now = Date.now()
  for (const [id, pending] of pendingFlows) {
    if (pending.expiresAt <= now) pendingFlows.delete(id)
  }
  if (pendingFlows.size >= MAX_PENDING_DEVICE_FLOWS) {
    const oldest = pendingFlows.keys().next().value
    if (typeof oldest === "string") pendingFlows.delete(oldest)
  }
  pendingFlows.set(deviceCode, state)
  void savePendingFlows()
}

export function getPendingFlow(flowId: string): PollState | undefined {
  return pendingFlows.get(flowId)
}

export function removePendingFlow(flowId: string): void {
  pendingFlows.delete(flowId)
}

export async function pollAccountFlow(flowId: string): Promise<{
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
    logger.debug(`Poll device flow: GitHub returned ${response.status}`)
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
    logger.debug("Poll device flow: GitHub response:", json)
  } catch (e) {
    logger.error("Poll device flow: Failed to parse GitHub response:", e)
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
    logger.debug(
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
      logger.info(`GitHub account added: ${account.label}`)
    })
    .catch((err: unknown) => {
      logger.warn(`Failed to initialize account "${account.label}":`, err)
    })

  flow.status = "complete"
  flow.accountId = account.id
  await savePendingFlows()

  // 模型缓存由 saveAccounts / refreshModelsForAccount 内部的
  // emitStateChange("models-stale") 自动触发,无需手动调用 cacheModels()。

  return { status: "complete", accountId: account.id }
}

export const deviceFlowRoutes = new Hono()

deviceFlowRoutes.post("/:flowId/poll", async (c) => {
  const result = await pollAccountFlow(c.req.param("flowId"))
  if (result.error) {
    return c.json({ error: result.error }, 404)
  }
  return c.json(result)
})
