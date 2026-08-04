import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import type { Account, AccountProvider } from "~/lib/accounts"

import { saveAccounts } from "~/lib/account-store"
import { addAccount, listAccounts } from "~/lib/accounts"
import { logger } from "~/lib/logger"
import { isProviderId } from "~/lib/provider-config"
import { readJsonBody } from "~/lib/request-body"
import { refreshModelsForAccount } from "~/lib/utils"
import { getDeviceCode } from "~/services/github/get-device-code"
import { initializeProviderRegistry } from "~/services/providers"

import { publicAccount } from "./accounts"
import { registerPendingFlow } from "./device-flow"

export const createAccountRoutes = new Hono()

createAccountRoutes.post("/", async (c) => {
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
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const provider =
    isProviderId(String(body.provider)) ? body.provider : "copilot"
  const label = body.label ?? `account-${listAccounts().length + 1}`

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
      settings: {
        ...settings,
        userId:
          typeof settings.userId === "string" ? settings.userId : undefined,
        proxy: typeof settings.proxy === "string" ? settings.proxy : undefined,
      },
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
    logger.error("Failed to initiate GitHub device flow:", e)
    return c.json({ error: "Failed to initiate GitHub device flow." }, 502)
  }

  const { device_code, user_code, verification_uri, expires_in, interval } =
    deviceCodeResponse

  registerPendingFlow(device_code, {
    label,
    provider: "copilot",
    interval,
    expiresAt: Date.now() + expires_in * 1000,
    status: "pending",
  })

  // Clean up expired flows after expiry
  setTimeout(async () => {
    const { getPendingFlow, savePendingFlows } = await import("./device-flow")
    const flow = getPendingFlow(device_code)
    if (flow && flow.status === "pending") {
      flow.status = "expired"
      await savePendingFlows()
    }
    setTimeout(async () => {
      const { removePendingFlow, savePendingFlows: save } = await import(
        "./device-flow"
      )
      removePendingFlow(device_code)
      await save()
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
