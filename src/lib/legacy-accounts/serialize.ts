import type { ProviderConnection } from "~/lib/provider-connections"

import {
  getCodebuffAuthToken,
  getGitHubToken,
  getMimoPh,
  getMimoServiceToken,
  getWindsurfApiKey,
  syncLegacyExhaustedState,
} from "~/lib/legacy-accounts"
import { isOAuthProviderId } from "~/lib/provider-config"

/**
 * Account 序列化(导出用)。
 *
 * Phase 3:从 account-store.ts 提取的序列化逻辑。
 * Phase 5:新增 serializeConnectionForExport,在 legacy-accounts/ 内部
 * 通过 connectionToAccount 派生 Account 快照再序列化,避免外部调用方
 * 经由 getAccount/connectionToAccount 绕路。
 */
import { connectionToAccount, type Account } from "./accounts"

/**
 * 将 Account 序列化为可导出的 JSON 对象。
 */
export function serializeAccountForExport(
  account: Account,
): Record<string, unknown> {
  return serializeAccount(account)
}

/**
 * 将 ProviderConnection 序列化为可导出的 JSON 对象。
 * 在 legacy-accounts/ 内部通过 connectionToAccount 派生 Account 快照,
 * 再复用 serializeAccount,确保导出形状与原实现完全一致。
 */
export function serializeConnectionForExport(
  conn: ProviderConnection,
): Record<string, unknown> {
  const account = connectionToAccount(conn)
  return serializeAccount(account)
}

function serializeAccount(account: Account): Record<string, unknown> {
  syncLegacyExhaustedState(account)
  const base: Record<string, unknown> = {
    id: account.id,
    label: account.label,
    provider: account.provider,
    enabled: account.enabled,
    priority: account.priority,
    quotaState: account.quotaState ?? "unknown",
    quotaExhaustedAt: account.quotaExhaustedAt,
    createdAt: account.createdAt,
    availableModels: account.availableModels,
    quotaInfo: account.quotaInfo,
    cooldownUntil: account.cooldownUntil,
  }

  if (account.provider === "copilot") {
    return {
      ...base,
      credentials: { githubToken: getGitHubToken(account) },
      settings: account.settings ?? {},
    }
  }

  if (account.provider === "codebuff") {
    return {
      ...base,
      credentials: { authToken: getCodebuffAuthToken(account) },
      settings: account.settings ?? {},
    }
  }

  if (account.provider === "windsurf") {
    return {
      ...base,
      credentials: { apiKey: getWindsurfApiKey(account) },
      settings: account.settings ?? {},
    }
  }

  if (isOAuthProviderId(account.provider)) {
    return {
      ...base,
      credentials: account.credentials ?? {},
      settings: account.settings ?? {},
      ...(account.cpaMetadata ? { cpaMetadata: account.cpaMetadata } : {}),
    }
  }

  return {
    ...base,
    credentials: {
      serviceToken: getMimoServiceToken(account),
      xiaomichatbotPh: getMimoPh(account),
      mimoWsToken: account.credentials?.mimoWsToken,
    },
    settings: account.settings ?? {},
  }
}
