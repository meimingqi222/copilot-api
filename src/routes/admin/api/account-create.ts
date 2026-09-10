import { Hono } from "hono"
import { randomUUID } from "node:crypto"

import type { Account, AccountProvider } from "~/lib/legacy-accounts"

import { saveAccounts } from "~/lib/account-store"
import { addAccount } from "~/lib/legacy-accounts"
import { logger } from "~/lib/logger"
import { isProviderId } from "~/lib/provider-config"
import {
  getProviderConnection,
  listAccountManagedConnections,
} from "~/lib/provider-connections"
import { readJsonBody } from "~/lib/request-body"
import { refreshModelsForAccount } from "~/lib/utils"
import { getDeviceCode } from "~/services/github/get-device-code"
import { initializeProviderRegistry } from "~/services/providers"

import { publicAccountFromConnection } from "./account-views"
import { registerPendingFlow } from "./device-flow"

/** 从 JWT 的 exp 字段提取过期时间（秒 → 毫秒）。 */
function extractJwtExp(token: string): number | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(
      Buffer.from(
        parts[1].replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString("utf8"),
    ) as { exp?: number }
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

interface CreateAccountBody {
  label?: string
  provider?: AccountProvider
  authToken?: string
  apiKey?: string
  serviceToken?: string
  xiaomichatbotPh?: string
  credentials?: Record<string, unknown>
  settings?: Record<string, unknown>
}

/**
 * 创建 LobsterAI 账号（token 粘贴式接入）。
 *
 * 抽成独立函数而非内联在路由处理器里：该处理器已有多个 provider 分支，
 * 内联会把圈复杂度推过 lint 上限。
 */
async function createLobsteraiAccount(
  body: CreateAccountBody,
  label: string,
): Promise<{ error: string } | { accountId: string; account: unknown }> {
  const accessToken =
    typeof body.credentials?.accessToken === "string" ?
      body.credentials.accessToken.trim()
    : body.authToken?.trim()
  const refreshToken =
    typeof body.credentials?.refreshToken === "string" ?
      body.credentials.refreshToken.trim()
    : undefined
  if (!accessToken && !refreshToken) {
    return { error: "LobsterAI accessToken or refreshToken is required." }
  }

  const expiresAt = accessToken ? extractJwtExp(accessToken) : undefined
  // keyfrom 归因字段（可选）：refresh 时原样回传，缺失时服务端默认 official。
  const uuid =
    typeof body.credentials?.uuid === "string" ?
      body.credentials.uuid.trim()
    : undefined
  const userId =
    typeof body.credentials?.userId === "string" ?
      body.credentials.userId.trim()
    : undefined

  const account: Account = {
    id: randomUUID(),
    label,
    provider: "lobsterai",
    enabled: true,
    priority: 0,
    quotaState: "unknown",
    createdAt: Date.now(),
    credentials: {
      accessToken: accessToken ?? "",
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(uuid ? { uuid } : {}),
      ...(userId ? { userId } : {}),
    },
    settings: {
      ...body.settings,
    },
  }

  addAccount(account)
  await refreshModelsForAccount(account)
  await saveAccounts()

  const conn = getProviderConnection(account.id)
  return {
    accountId: account.id,
    account: conn ? publicAccountFromConnection(conn) : undefined,
  }
}

export const createAccountRoutes = new Hono()

createAccountRoutes.post("/", async (c) => {
  initializeProviderRegistry()
  let body: CreateAccountBody
  try {
    body = await readJsonBody(c.req.raw)
  } catch {
    return c.json({ error: "Invalid JSON payload." }, 400)
  }

  const provider =
    isProviderId(String(body.provider)) ? body.provider : "copilot"
  // 使用 connection 原生列表生成默认 label(替代 listAccounts().length)
  const label =
    body.label ?? `account-${listAccountManagedConnections().length + 1}`

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

    const conn = getProviderConnection(account.id)
    return c.json({
      status: "complete",
      accountId: account.id,
      account: conn ? publicAccountFromConnection(conn) : undefined,
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

    const conn = getProviderConnection(account.id)
    return c.json({
      status: "complete",
      accountId: account.id,
      account: conn ? publicAccountFromConnection(conn) : undefined,
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

    const conn = getProviderConnection(account.id)
    return c.json({
      status: "complete",
      accountId: account.id,
      account: conn ? publicAccountFromConnection(conn) : undefined,
    })
  }

  if (provider === "codebuddy") {
    const accessToken =
      typeof body.credentials?.accessToken === "string" ?
        body.credentials.accessToken.trim()
      : body.authToken?.trim()
    const refreshToken =
      typeof body.credentials?.refreshToken === "string" ?
        body.credentials.refreshToken.trim()
      : undefined
    if (!accessToken && !refreshToken) {
      return c.json(
        { error: "CodeBuddy accessToken or refreshToken is required." },
        400,
      )
    }

    const expiresAt = accessToken ? extractJwtExp(accessToken) : undefined

    const account: Account = {
      id: randomUUID(),
      label,
      provider,
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: accessToken ?? "",
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
      settings: {
        ...body.settings,
      },
    }

    addAccount(account)
    await refreshModelsForAccount(account)
    await saveAccounts()

    const conn = getProviderConnection(account.id)
    return c.json({
      status: "complete",
      accountId: account.id,
      account: conn ? publicAccountFromConnection(conn) : undefined,
    })
  }

  if (provider === "lobsterai") {
    const result = await createLobsteraiAccount(body, label)
    if ("error" in result) {
      return c.json({ error: result.error }, 400)
    }
    return c.json({
      status: "complete",
      accountId: result.accountId,
      account: result.account,
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
