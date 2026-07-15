/**
 * accounts.json → provider-connections.json 迁移基础设施。
 *
 * 提供 `accountToConnectionForPersistence`（增强版 accountToConnection，
 * metadata 包含完整 AccountLegacyMetadata）和 `migrateAccountsToConnections`
 * （批量转换入口）。
 *
 * 本模块不接入启动序列，不改变任何运行时行为（批次 0）。
 * 批次 1 在 loadAccounts/initializeProviderConnections 中调用本模块。
 */
import type { Account, AccountModel, AccountRuntimeState } from "~/lib/accounts"

import { isOAuthAccount } from "~/lib/accounts"
import { getAccountProtocol } from "~/lib/request-admission"

import type { CredentialRefresherType } from "./credential-refresher"
import type {
  ApiCredential,
  ModelEndpoint,
  ModelMapping,
  ProviderConnection,
} from "./types"

import { buildAccountLegacyMetadata } from "./connection-metadata"

/**
 * Account quotaState → CredentialStatus 映射。
 */
function mapQuotaStateToCredentialStatus(
  quotaState?: "unknown" | "available" | "exhausted",
  cooldownUntil?: number,
  authStatus?: AccountRuntimeState["authStatus"],
): ApiCredential["status"] {
  if (authStatus === "error") return "auth_error"
  if (quotaState === "exhausted") return "quota_exhausted"
  if (cooldownUntil && cooldownUntil > Date.now()) return "cooldown"
  return "ready"
}

/**
 * AccountModel → ModelMapping 映射。
 * 镜像 account-adapter.ts 的 accountModelToMapping。
 */
function accountModelToMapping(model: AccountModel): ModelMapping {
  const endpoints: Array<ModelEndpoint> = []
  for (const ep of model.supportedEndpoints) {
    if (ep.includes("chat/completions")) endpoints.push("chat")
    else if (ep.includes("messages")) endpoints.push("messages")
    else if (ep.includes("responses")) endpoints.push("responses")
    else if (ep.includes("embeddings")) endpoints.push("embeddings")
    else if (ep.includes("images")) endpoints.push("images")
    else if (ep.includes("videos")) endpoints.push("videos")
  }
  if (endpoints.length === 0) endpoints.push("chat")

  return {
    publicId: model.id,
    upstreamId: model.upstreamId ?? model.id,
    name: model.name,
    vendor: model.vendor,
    endpoints,
    enabled: true,
    pickerEnabled: model.pickerEnabled,
    pickerCategory: model.pickerCategory,
  }
}

/**
 * 安全读取 credentials 字段。
 */
function readCredentialString(
  account: Account,
  key: string,
): string | undefined {
  const value = account.credentials?.[key]
  return typeof value === "string" ? value : undefined
}

/**
 * 获取 account 的当前生效 token（credential.value）。
 * 镜像 account-adapter.ts 的 getAccountTokenValue。
 */
function getAccountTokenValue(account: Account): string {
  if (account.provider === "copilot") {
    return account.runtimeState?.copilotToken ?? ""
  }
  if (account.provider === "codebuff") {
    return readCredentialString(account, "authToken") ?? ""
  }
  if (account.provider === "windsurf") {
    return readCredentialString(account, "apiKey") ?? ""
  }
  if (account.provider === "mimo-aistudio") {
    return readCredentialString(account, "serviceToken") ?? ""
  }
  if (isOAuthAccount(account)) {
    return readCredentialString(account, "accessToken") ?? ""
  }
  return ""
}

/**
 * 获取 account 的刷新源材料（credential.context）。
 * 镜像 account-adapter.ts 的 getAccountContext。
 */
function getAccountContext(account: Account): Record<string, unknown> {
  const base = { accountId: account.id }
  if (account.provider === "copilot") {
    return {
      ...base,
      githubToken: readCredentialString(account, "githubToken"),
      copilotTokenExpiry: account.runtimeState?.copilotTokenExpiry,
    }
  }
  if (account.provider === "windsurf") {
    return {
      ...base,
      windsurfJwt: account.runtimeState?.windsurfJwt,
      windsurfJwtFetchedAt: account.runtimeState?.windsurfJwtFetchedAt,
    }
  }
  if (isOAuthAccount(account)) {
    return {
      ...base,
      accessToken: readCredentialString(account, "accessToken"),
      refreshToken: readCredentialString(account, "refreshToken"),
      expiresAt: account.credentials?.expiresAt,
      idToken: readCredentialString(account, "idToken"),
      oauthAccountId: readCredentialString(account, "accountId"),
      projectId: readCredentialString(account, "projectId"),
      deviceId: readCredentialString(account, "deviceId"),
      apiKey: readCredentialString(account, "apiKey"),
    }
  }
  return base
}

/**
 * 获取 refresherType。
 * 镜像 account-adapter.ts 的 getRefresherType。
 */
function getRefresherType(account: Account): CredentialRefresherType {
  if (account.provider === "copilot") return "copilot-token"
  if (isOAuthAccount(account)) return "oauth-token"
  if (account.provider === "windsurf") return "windsurf-jwt"
  return "static"
}

/**
 * 获取 OAuth account 副标题。
 * 镜像 account-adapter.ts 的 getOAuthAccountSubtitle。
 */
function getOAuthAccountSubtitle(account: Account): string | undefined {
  if (!isOAuthAccount(account)) return undefined
  const email = account.credentials?.email?.trim()
  if (email && email !== account.label) return email
  const projectId = account.credentials?.projectId?.trim()
  if (
    account.provider === "antigravity"
    && projectId
    && projectId !== account.label
  ) {
    return projectId
  }
  const accountId = account.credentials?.accountId?.trim()
  if (accountId && accountId !== account.label) return accountId
  return undefined
}

/**
 * 增强版 accountToConnection，用于持久化迁移。
 *
 * 与 accountToConnection 的差异：
 * - metadata 包含完整 AccountLegacyMetadata（含 credentialExtras、
 *   quotaExhaustedAt、lastRateLimitAt、lastRateLimitReason、isExhausted 等
 *   accountToConnection 未塞入的字段）。
 * - availableModels 转换为 connection.models（与 accountToConnection 一致），
 *   不在 metadata 中保留原始 Array<AccountModel>（附录 A 决策）。
 * - OAuth subtitle 从 credentials 派生后写入 metadata。
 */
export function accountToConnectionForPersistence(
  account: Account,
): ProviderConnection {
  const protocol = getAccountProtocol(account)

  const credentialStatus = mapQuotaStateToCredentialStatus(
    account.quotaState,
    account.cooldownUntil,
    account.runtimeState?.authStatus,
  )

  const credential: ApiCredential = {
    id: account.id,
    authMode: "bearer",
    value: getAccountTokenValue(account),
    enabled: account.enabled,
    status: credentialStatus,
    cooldownUntil: account.cooldownUntil,
    lastError:
      account.runtimeState?.authStatus === "error" ?
        account.runtimeState.lastError
      : undefined,
    createdAt: account.createdAt,
    refresherType: getRefresherType(account),
    context: getAccountContext(account),
  }

  const models: Array<ModelMapping> | undefined =
    account.availableModels ?
      account.availableModels.map((m) => accountModelToMapping(m))
    : undefined

  // 构建完整 AccountLegacyMetadata
  const legacyMetadata = buildAccountLegacyMetadata(account)

  // OAuth subtitle
  if (isOAuthAccount(account)) {
    const subtitle = getOAuthAccountSubtitle(account)
    if (subtitle) {
      legacyMetadata.subtitle = subtitle
    }
  }

  return {
    id: account.id,
    name: account.label,
    protocol,
    baseUrl: "",
    enabled: account.enabled,
    priority: account.priority,
    credentials: [credential],
    models,
    createdAt: account.createdAt,
    metadata: legacyMetadata as unknown as Record<string, unknown>,
  }
}

/**
 * 批量将 Account 列表迁移为 ProviderConnection 列表。
 *
 * 保持 id 不变（风险 5.9：绝不生成新 id，否则 stats-store 历史断链）。
 * runtimeState 不持久化（与 serializeAccount 现状一致）。
 */
export function migrateAccountsToConnections(
  accounts: Array<Account>,
): Array<ProviderConnection> {
  return accounts.map((a) => accountToConnectionForPersistence(a))
}
