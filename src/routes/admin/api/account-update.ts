import type { Account } from "~/lib/accounts"

import {
  type AccountConnectionPatch,
  applyConnectionPatchToAccount,
  patchRequiresModelRefresh,
} from "~/lib/account-adapter"
import { refreshCopilotToken } from "~/lib/account-store"
import {
  getGitHubToken,
  isOAuthAccount,
  setCopilotToken,
  setCopilotTokenExpiry,
} from "~/lib/accounts"
import { isOAuthProviderId } from "~/lib/provider-config"
import { refreshModelsForAccount } from "~/lib/utils"

export interface UpdateAccountBody {
  label?: string
  enabled?: boolean
  priority?: number
  authToken?: string
  apiKey?: string
  githubToken?: string
  serviceToken?: string
  xiaomichatbotPh?: string
  credentials?: Record<string, unknown>
  settings?: Record<string, unknown>
}

/**
 * 将 admin 请求体解析为 connection 级别的补丁。
 * provider-specific 的字段提取(body.authToken / body.apiKey / body.serviceToken 等)
 * 集中在此函数内,后续 applyConnectionPatchToAccount 只需处理通用补丁。
 */
export function parseBodyToPatch(
  account: Account,
  body: UpdateAccountBody,
): AccountConnectionPatch {
  const patch: AccountConnectionPatch = {
    label: body.label,
    enabled: body.enabled,
    priority: body.priority,
    settings: body.settings,
  }

  if (account.provider === "copilot") {
    const githubToken =
      typeof body.credentials?.githubToken === "string" ?
        body.credentials.githubToken
      : body.githubToken
    if (
      Object.hasOwn(body, "githubToken")
      || Object.hasOwn(body.credentials ?? {}, "githubToken")
    ) {
      patch.credentialValue = githubToken ?? ""
    }
    return patch
  }

  if (account.provider === "codebuff") {
    const authToken =
      typeof body.credentials?.authToken === "string" ?
        body.credentials.authToken
      : body.authToken
    if (
      Object.hasOwn(body, "authToken")
      || Object.hasOwn(body.credentials ?? {}, "authToken")
    ) {
      patch.credentialValue = authToken ?? ""
    }
    return patch
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
      patch.credentialValue = apiKey ?? ""
    }
    return patch
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

    const extras: Record<string, string | undefined> = {}
    if (
      Object.hasOwn(body, "serviceToken")
      || Object.hasOwn(body.credentials ?? {}, "serviceToken")
      || Object.hasOwn(body.settings ?? {}, "serviceToken")
    ) {
      patch.credentialValue = serviceToken ?? ""
    }
    if (
      Object.hasOwn(body, "xiaomichatbotPh")
      || Object.hasOwn(body.credentials ?? {}, "xiaomichatbotPh")
      || Object.hasOwn(body.settings ?? {}, "xiaomichatbotPh")
    ) {
      extras.xiaomichatbotPh = xiaomichatbotPh
    }
    // userId 和 proxy 走 settings,但需要 trim/clear 语义,放到 extras 处理
    if (body.settings && typeof body.settings.userId === "string") {
      extras.userId = body.settings.userId
    }
    if (Object.hasOwn(body.settings ?? {}, "proxy")) {
      const proxy =
        typeof body.settings?.proxy === "string" ?
          body.settings.proxy
        : undefined
      extras.proxy = proxy
    }
    if (Object.keys(extras).length > 0) {
      patch.credentialExtras = extras
    }
    return patch
  }

  if (isOAuthAccount(account) && isOAuthProviderId(account.provider)) {
    // OAuth 暂无 credentialValue 更新(accessToken 通过刷新流程获取)
    // settings 补丁直接传递
    return patch
  }

  return patch
}

export async function updateProviderAccount(
  account: Account,
  body: UpdateAccountBody,
): Promise<void> {
  const patch = parseBodyToPatch(account, body)
  const copilotTokenRotated =
    account.provider === "copilot" && patch.credentialValue !== undefined
  applyConnectionPatchToAccount(account, patch)
  if (copilotTokenRotated) {
    setCopilotToken(account, undefined)
    setCopilotTokenExpiry(account, undefined)
    if (getGitHubToken(account)) {
      await refreshCopilotToken(account)
    }
  }
  if (patchRequiresModelRefresh(patch)) {
    await refreshModelsForAccount(account)
  }
}
