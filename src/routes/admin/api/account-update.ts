import type { Account } from "~/lib/accounts"

import {
  setCodebuffAuthToken,
  setWindsurfApiKey,
  setMimoServiceToken,
  setMimoPh,
  setMimoProxy,
  setMimoUserId,
} from "~/lib/accounts"
import { refreshModelsForAccount } from "~/lib/utils"

export async function updateProviderAccount(
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
