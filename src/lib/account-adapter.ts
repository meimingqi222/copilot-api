/**
 * Account ↔ ProviderConnection 双向适配层。
 *
 * 正向:`accountToConnection(account)` 将 legacy Account 联合类型转换为
 * ProviderConnection,以便统一从 connections 列表构建 RouteTarget。
 *
 * 反向:`applyConnectionPatchToAccount(account, patch)` 将 connection 级别的
 * 写入请求(label/enabled/priority/credential.value/settings)翻译回 Account 的
 * provider-specific 字段。Admin API 通过此逆映射操作 Account,无需直接接触
 * 联合类型分支,为 Step D(消除 Account 联合类型)铺路。
 *
 * 策略:读适配 + 单一写入源(Account)。
 * state.accounts 仍为唯一写入源;accounts.json 仍为底层存储。
 */
import type { Account, AccountModel, AccountRuntimeState } from "~/lib/accounts"
import type {
  ApiCredential,
  CredentialStatus,
  ModelEndpoint,
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections/types"

import { isOAuthAccount } from "~/lib/accounts"
import { getAccountProtocol } from "~/lib/request-admission"

/**
 * Account quotaState → CredentialStatus 映射。
 */
function mapQuotaStateToCredentialStatus(
  quotaState?: "unknown" | "available" | "exhausted",
  cooldownUntil?: number,
  authStatus?: AccountRuntimeState["authStatus"],
): CredentialStatus {
  if (authStatus === "error") return "auth_error"
  if (quotaState === "exhausted") return "quota_exhausted"
  if (cooldownUntil && cooldownUntil > Date.now()) return "cooldown"
  return "ready"
}

/**
 * AccountModel → ModelMapping 映射。
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
 * 安全读取 credentials 字段(可能为 undefined)。
 */
function readCredentialString(
  account: Account,
  key: string,
): string | undefined {
  const value = account.credentials?.[key]
  return typeof value === "string" ? value : undefined
}

/**
 * 获取 account 的当前生效 token(credential.value)。
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
 * 获取 account 的刷新源材料(credential.context)。
 */
function getAccountContext(account: Account): Record<string, unknown> {
  // accountId 始终写入,供 CredentialRefresher 反查 state.accounts
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
      // 注意:OAuth account 的 credentials.accountId 是上游账户 id(非本地 account.id),
      // 已通过 base.accountId 提供本地 id,这里保留上游 accountId 用于兼容
      oauthAccountId: readCredentialString(account, "accountId"),
      projectId: readCredentialString(account, "projectId"),
      deviceId: readCredentialString(account, "deviceId"),
      apiKey: readCredentialString(account, "apiKey"),
    }
  }
  return base
}

/**
 * 获取 account 的扩展元数据(connection.metadata)。
 *
 * 包含两类字段:
 * 1. provider-specific 配置(proxy/modelPrefix/tokenEndpoint 等)—— 供 routing/refresher 读取
 * 2. admin-only 视图字段(provider/authStatus/lastError/exhaustedAt/quotaState/quotaInfo/
 *    settings/subtitle)—— 供 admin 序列化读取,使 publicAccount() 可从 connection 派生
 */
function getAccountMetadata(account: Account): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    // admin-only 视图字段(所有 provider 通用)
    provider: account.provider,
    authStatus: account.runtimeState?.authStatus ?? "ready",
    authError: account.runtimeState?.lastError ?? null,
    exhaustedAt: account.exhaustedAt,
    quotaState: account.quotaState ?? "unknown",
    quotaInfo: account.quotaInfo ?? null,
    settings: account.settings ?? {},
  }

  if (isOAuthAccount(account)) {
    const oauth = account
    metadata.subtitle = getOAuthAccountSubtitle(oauth)
    if (oauth.cpaMetadata) {
      metadata.cpaMetadata = oauth.cpaMetadata
    }
    if (oauth.settings?.proxyUrl) {
      metadata.proxyUrl = oauth.settings.proxyUrl
    }
    if (oauth.settings?.modelPrefix) {
      metadata.modelPrefix = oauth.settings.modelPrefix
    }
    if (oauth.settings?.tokenEndpoint) {
      metadata.tokenEndpoint = oauth.settings.tokenEndpoint
    }
    if (oauth.settings?.redirectUri) {
      metadata.redirectUri = oauth.settings.redirectUri
    }
  }

  if (account.provider === "mimo-aistudio") {
    if (account.settings?.proxy) {
      metadata.proxy = account.settings.proxy
    }
    if (account.settings?.userId) {
      metadata.userId = account.settings.userId
    }
  }

  return metadata
}

/**
 * 获取 OAuth account 副标题(邮箱/accountId)。
 * 镜像 services/oauth/account-label.ts 的逻辑,避免 admin 适配层反向依赖 services。
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
 * 获取 refresherType。
 */
function getRefresherType(
  account: Account,
): "copilot-token" | "oauth-token" | "windsurf-jwt" | "static" {
  if (account.provider === "copilot") return "copilot-token"
  if (isOAuthAccount(account)) return "oauth-token"
  if (account.provider === "windsurf") return "windsurf-jwt"
  return "static"
}

/**
 * 将 Account 转换为 ProviderConnection。
 *
 * 生成的 connection 包含:
 * - 单一 credential(从 account 的 token 映射)
 * - 模型列表(从 account.availableModels 映射,或空数组表示尚未加载)
 * - 元数据(从 account.settings/cpaMetadata 映射)
 */
export function accountToConnection(account: Account): ProviderConnection {
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

  const metadata = getAccountMetadata(account)

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
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  }
}

/**
 * 将 Account 列表转换为虚拟 ProviderConnection 列表。
 * 用于注入到 buildRouteTargets 的 connections 候选池中。
 */
export function accountsToConnections(
  accounts: Array<Account>,
): Array<ProviderConnection> {
  return accounts.map((a) => accountToConnection(a))
}

// ────────────────────────────────────────────────────────────────
// Reverse mapper: Connection patch → Account field writes
// ────────────────────────────────────────────────────────────────

/**
 * Connection 级别的 account 更新补丁。
 *
 * Admin API 收到的请求体先在 route 层解析为此 patch 结构,
 * 再由 `applyConnectionPatchToAccount` 翻译为 provider-specific 的 Account 写入。
 * 这样 admin 路由无需直接接触 Account 联合类型分支。
 */
export interface AccountConnectionPatch {
  /** Connection 名称(对应 account.label) */
  label?: string
  /** Connection/credential enabled 标志 */
  enabled?: boolean
  /** Connection 优先级(0-100,会被 clamp) */
  priority?: number
  /**
   * 主凭据值(provider-specific:copilot→githubToken / codebuff→authToken /
   * windsurf→apiKey / mimo→serviceToken / oauth→accessToken)。
   * 传 undefined 表示不更新;传空字符串表示清除。
   */
  credentialValue?: string
  /**
   * 次要凭据字段(目前仅 mimo 使用:xiaomichatbotPh / userId / proxy)。
   * 值为 undefined 表示不更新;空字符串表示清除。
   */
  credentialExtras?: Record<string, string | undefined>
  /** Settings 补丁(与 provider-specific settings 合并,空字符串会被清除为 undefined) */
  settings?: Record<string, unknown>
}

/**
 * 将 connection 级别的补丁应用到 Account。
 *
 * 这是 `accountToConnection` 的逆映射:把 label/enabled/priority/credentialValue/
 * settings 等 connection 概念翻译回 Account 的 provider-specific 字段。
 *
 * - 纯字段写入,不触发 model refresh(由调用方决定何时刷新)
 * - provider-specific 分支集中在此函数内,admin 路由无需重复
 */
export function applyConnectionPatchToAccount(
  account: Account,
  patch: AccountConnectionPatch,
): void {
  if (patch.label !== undefined) {
    account.label = patch.label
  }
  if (patch.enabled !== undefined) {
    account.enabled = patch.enabled
  }
  if (patch.priority !== undefined) {
    account.priority = Math.max(0, Math.min(100, patch.priority))
  }
  if (patch.credentialValue !== undefined) {
    applyCredentialValue(account, patch.credentialValue)
  }
  if (patch.credentialExtras) {
    applyCredentialExtras(account, patch.credentialExtras)
  }
  if (patch.settings) {
    applySettingsPatch(account, patch.settings)
  }
}

/**
 * 是否需要根据补丁内容触发 model 刷新。
 * 仅当 credentialValue 或 settings 变更时才需要刷新模型列表。
 */
export function patchRequiresModelRefresh(
  patch: AccountConnectionPatch,
): boolean {
  return patch.credentialValue !== undefined || Boolean(patch.settings)
}

/**
 * 直接写入 credentials 字段(覆盖单字段,保留其余)。
 */
function setCredentialField(
  account: Account,
  key: string,
  value: string | undefined,
): void {
  const current = account.credentials ?? {}
  account.credentials =
    value === undefined ?
      Object.fromEntries(Object.entries(current).filter(([k]) => k !== key))
    : { ...current, [key]: value }
}

/**
 * 直接写入 settings 字段(覆盖单字段,保留其余)。
 */
function setSettingsField(
  account: Account,
  key: string,
  value: string | undefined,
): void {
  const current = account.settings ?? {}
  account.settings =
    value === undefined ?
      Object.fromEntries(Object.entries(current).filter(([k]) => k !== key))
    : { ...current, [key]: value }
}

function applyCredentialValue(account: Account, value: string): void {
  const trimmed = value.trim() || undefined
  switch (account.provider) {
    case "copilot": {
      setCredentialField(account, "githubToken", trimmed)

      break
    }
    case "codebuff": {
      setCredentialField(account, "authToken", trimmed)

      break
    }
    case "windsurf": {
      setCredentialField(account, "apiKey", trimmed)

      break
    }
    case "mimo-aistudio": {
      setCredentialField(account, "serviceToken", trimmed)

      break
    }
    default: {
      if (isOAuthAccount(account)) {
        setCredentialField(account, "accessToken", trimmed)
      }
    }
  }
}

function applyCredentialExtras(
  account: Account,
  extras: Record<string, string | undefined>,
): void {
  if (account.provider !== "mimo-aistudio") return
  if ("xiaomichatbotPh" in extras) {
    setCredentialField(
      account,
      "xiaomichatbotPh",
      extras.xiaomichatbotPh?.trim() || undefined,
    )
  }
  if ("userId" in extras) {
    setSettingsField(account, "userId", extras.userId?.trim() || undefined)
  }
  if ("proxy" in extras) {
    setSettingsField(account, "proxy", extras.proxy?.trim() || undefined)
  }
}

function applySettingsPatch(
  account: Account,
  settings: Record<string, unknown>,
): void {
  if (isOAuthAccount(account)) {
    // OAuth settings 有字段白名单 + 空字符串清除为 undefined 的语义
    for (const key of [
      "baseUrl",
      "proxyUrl",
      "modelPrefix",
      "tokenEndpoint",
      "redirectUri",
    ]) {
      if (typeof settings[key] === "string") {
        setSettingsField(account, key, settings[key].trim() || undefined)
      }
    }
    // useApi 是布尔开关(xAI CLI/API 端点切换)。接受布尔或字符串形式,
    // 显式 false 会写入(而非清除),以便与 undefined(未设置)默认值区分。
    if ("useApi" in settings) {
      const raw = settings.useApi
      let value: boolean | undefined
      if (typeof raw === "boolean") {
        value = raw
      } else if (typeof raw === "string") {
        value = raw.trim().toLowerCase() === "true"
      }
      account.settings = { ...account.settings, useApi: value }
    }
  } else {
    // 其他 provider:直接合并 settings(保留原始值,不强制 trim/clear)
    account.settings = { ...account.settings, ...settings }
  }
}
