/**
 * 把 ProviderConnection + ApiCredential + ModelMapping 和 legacy Account
 * 展平为可调度的 RouteTarget。
 *
 * 输出按 (publicId, endpoint) 维度组织,选择器在此基础上做优先级与权重判定。
 *
 * Step A(3.2):state.accounts 通过 accountToConnection 转换为虚拟 ProviderConnection,
 * 注入到 connections 候选池中。account 循环分支已删除,但生成的虚拟 connection target
 * 仍携带 `account` 字段用于 build 时模型匹配,但 RouteTarget 不再包含 account 字段。
 */

import type { Account, AccountModel } from "~/lib/accounts"
import type { ProviderId } from "~/lib/provider-config"

import { accountToConnection } from "~/lib/account-adapter"
import { isAccountAvailable } from "~/lib/account-availability"
import {
  buildAccountModelAliases,
  getAccountModelPrefix,
  listAccounts,
} from "~/lib/accounts"
import {
  connectionMatchesAliasRestriction,
  getExposedAliasEntries,
  type ModelAliasRestriction,
} from "~/lib/model-aliases"
import {
  DEFAULTS,
  isAccountManagedConnection,
  isCredentialAvailable,
  listProviderConnections,
  refreshConnectionAvailability,
  type ApiCredential,
  type ModelEndpoint,
  type ModelMapping,
  type ProviderConnection,
  type RouteTarget,
} from "~/lib/provider-connections"

function safeCredentials(connection: ProviderConnection): Array<ApiCredential> {
  const credentials = (connection as { credentials?: unknown }).credentials
  return Array.isArray(credentials) ? (credentials as Array<ApiCredential>) : []
}

export interface BuildRouteTargetsOptions {
  /** 限定只构造此 publicId / alias 对应的 target。 */
  publicModelId?: string
  /** 强制指定的 connection id(对应 `providerId/model` 引用形式)。 */
  connectionId?: string
  /** 限定 endpoint(chat/messages/responses/embeddings)。 */
  endpoint?: ModelEndpoint
  /** 是否只保留 enabled+ready 的 credential/connection。默认 true。 */
  onlyAvailable?: boolean
  /** 自定义 connection 列表(供测试)。 */
  connections?: Array<ProviderConnection>
  /** 自定义 account 列表(供测试);默认从 state.accounts 读取。 */
  accounts?: Array<Account>
  /** 仅匹配指定 legacy provider 的账户。 */
  legacyProvider?: ProviderId
  /** 仅匹配指定 modelPrefix 的账户。 */
  accountPrefix?: string
  /** Restrict candidates to the scope of a matched global alias rule. */
  aliasRestriction?: ModelAliasRestriction
}

export function buildRouteTargets(
  options: BuildRouteTargetsOptions = {},
): Array<RouteTarget> {
  const onlyAvailable = options.onlyAvailable ?? true
  const rawConnections = options.connections ?? listProviderConnections()
  // account-managed connections(*-native protocol)已在 stateRoot.connections 中,
  // 但它们也会通过 state.accounts → accountToConnection 作为虚拟 connection 加入。
  // 为避免重复,从 baseConnections 中排除 account-managed connections。
  // 判别器用 protocol 派生(非 AccountLegacyMetadata),T5.2.5 后仍然有效。
  const baseConnections = rawConnections.filter(
    (conn) => !isAccountManagedConnection(conn),
  )
  const accounts = options.accounts ?? listAccounts()

  // Step A(3.2):state.accounts 通过 accountToConnection 转换为虚拟 ProviderConnection,
  // 合并到 connections 候选池。批次 3：RouteTarget.account 已删除，
  // account 仅在 build 时用于模型匹配/端点解析，不放入 RouteTarget。
  const virtualConnections: Array<{
    connection: ProviderConnection
    account: Account
  }> = []
  for (const account of accounts) {
    if (onlyAvailable && !isAccountAvailable(account)) {
      continue
    }
    if (options.legacyProvider && account.provider !== options.legacyProvider) {
      continue
    }
    if (options.accountPrefix) {
      const prefix = getAccountModelPrefix(account).toLowerCase()
      if (prefix !== options.accountPrefix.toLowerCase()) continue
    }
    // availableModels === []：已加载但为空,跳过此账户
    if (
      account.availableModels !== undefined
      && account.availableModels.length === 0
    ) {
      continue
    }
    virtualConnections.push({
      connection: accountToConnection(account),
      account,
    })
  }

  // 合并:先普通 connection,再虚拟 connection(account-backed)
  // connectionId 过滤时虚拟 connection 也要参与
  const allConnections: Array<{
    connection: ProviderConnection
    account?: Account
  }> = [
    ...baseConnections.map((connection) => ({
      connection,
      account: undefined as Account | undefined,
    })),
    ...virtualConnections.map(({ connection, account }) => ({
      connection,
      account,
    })),
  ]

  const targets: Array<RouteTarget> = []

  for (const { connection, account } of allConnections) {
    if (options.connectionId && connection.id !== options.connectionId) continue
    if (
      !connectionMatchesAliasRestriction(connection, options.aliasRestriction)
    ) {
      continue
    }
    if (onlyAvailable && !connection.enabled) continue

    const credentials = safeCredentials(connection)
    // 直接在原 connection 上 refresh,让 stateRoot 中的 credential
    // 状态被正确恢复(已过期的 cooldown / quota_exhausted → ready)。
    refreshConnectionAvailability(connection)

    // account-backed 虚拟 connection 特殊处理:availableModels === undefined 生成通配 target
    if (account && account.availableModels === undefined) {
      // 尚未加载:为请求的模型生成通配 target(publicModelId 为空则不生成)
      if (!options.publicModelId) continue
      const ep: Array<ModelEndpoint> =
        options.endpoint ?
          [options.endpoint]
        : (["chat"] as Array<ModelEndpoint>)
      for (const endpoint of ep) {
        if (options.connectionId && connection.id !== options.connectionId)
          continue
        targets.push({
          connectionId: connection.id,
          connectionName: connection.name,
          protocol: connection.protocol,
          credentialId: credentials[0]?.id ?? connection.id,
          publicModelId: options.publicModelId,
          upstreamModelId: options.publicModelId,
          endpoint,
          // 通配 target 作为兜底:selectRouteTarget 的两阶段过滤
          // 优先选择专用(非通配) target,仅当无专用 target 时才选通配。
          // connectionPriority 保留 connection.priority 原值,
          // 仅在同一层级(专用或通配)内参与优先级比较。
          connectionPriority: connection.priority,
          connectionWeight: connection.weight ?? DEFAULTS.CONNECTION_WEIGHT,
          credentialPriority:
            credentials[0]?.priority ?? DEFAULTS.CREDENTIAL_PRIORITY,
          credentialWeight:
            credentials[0]?.weight ?? DEFAULTS.CREDENTIAL_WEIGHT,
          isWildcard: true,
        })
      }
      continue
    }

    const models = connection.models ?? []
    for (const model of models) {
      if (!model.enabled) continue
      // Both account-backed and plain connections use resolveEndpoints so a
      // request for one endpoint (e.g. "messages") can fall back to another
      // the connection actually supports (e.g. "chat"), enabling cross-protocol
      // translation in the dispatch layer.
      const resolved = resolveEndpoints(model.endpoints, options.endpoint)
      if (!resolved) continue
      if (options.publicModelId) {
        // 对 account-backed 虚拟 connection,使用 account 别名匹配;
        // 对普通 connection,使用 connection 别名匹配
        const matched =
          account ?
            matchesAccountModel(
              account,
              modelToAccountModel(model),
              options.publicModelId,
            )
          : matchesPublicModelId(model, options.publicModelId)
        if (!matched) continue
      }

      for (const credential of credentials) {
        if (onlyAvailable && !isCredentialAvailable(credential)) continue

        // account-backed 虚拟 connection:保留请求时的 publicModelId(可能带 provider/自定义前缀),
        // upstreamModelId 用 model.upstreamId(已剥离前缀)
        const publicModelId =
          account ? (options.publicModelId ?? model.publicId) : model.publicId
        pushResolvedTargets(targets, resolved.endpoints, {
          connection,
          credential,
          model,
          publicModelId,
          isTranslated: resolved.translated,
        })
      }
    }
  }

  return targets
}

function pushResolvedTargets(
  out: Array<RouteTarget>,
  endpoints: Array<ModelEndpoint>,
  fields: {
    connection: ProviderConnection
    credential: ApiCredential
    model: ModelMapping
    publicModelId: string
    isTranslated: boolean
  },
): void {
  const { connection, credential, model, publicModelId, isTranslated } = fields
  for (const endpoint of endpoints) {
    out.push({
      connectionId: connection.id,
      connectionName: connection.name,
      protocol: connection.protocol,
      credentialId: credential.id,
      publicModelId,
      upstreamModelId: model.upstreamId,
      endpoint,
      connectionPriority: connection.priority,
      connectionWeight: connection.weight ?? DEFAULTS.CONNECTION_WEIGHT,
      credentialPriority: credential.priority ?? DEFAULTS.CREDENTIAL_PRIORITY,
      credentialWeight: credential.weight ?? DEFAULTS.CREDENTIAL_WEIGHT,
      ...(isTranslated && { isTranslated: true }),
    })
  }
}

/** 将 ModelMapping 转回 AccountModel 形态(仅用于 matchesAccountModel 的别名匹配)。 */
function modelToAccountModel(model: ModelMapping): AccountModel {
  // AccountModel.id 与 ModelMapping.publicId 对应;
  // supportedEndpoints 用空数组占位,matchesAccountModel 只用 id/buildAccountModelAliases
  return {
    id: model.publicId,
    name: model.name || model.publicId,
    vendor: model.vendor ?? "unknown",
    pickerEnabled: model.pickerEnabled ?? true,
    pickerCategory: model.pickerCategory,
    supportedEndpoints: [],
  }
}

function matchesPublicModelId(model: ModelMapping, requested: string): boolean {
  const normalized = requested.toLowerCase()
  if (model.publicId.toLowerCase() === normalized) return true
  if (model.aliases?.some((alias) => alias.toLowerCase() === normalized)) {
    return true
  }
  return false
}

/**
 * 根据请求的 endpoint 从模型支持的 endpoint 列表中解析出实际执行的 endpoint 列表。
 * 不支持时可 fallback 到语义等价的 endpoint；embeddings 不做 fallback。
 * 返回 null 表示该模型不支持此 endpoint，应跳过。
 * `translated` 表示走的是 fallback 分支（dispatch 层需做协议翻译），
 * 供 `selectRouteTarget` 在同级候选中优先选原生 endpoint。
 *
 * fallback 映射（ordered candidates，首个命中的优先）：
 * - responses → [chat]：上游只支持 chat completions 但客户端用 responses API，
 *   由 dispatch 的 createResponsesViaChat 自动转换
 * - messages  → [chat]：上游只支持 chat completions 但客户端用 anthropic
 *   messages API，由 createMessagesViaChat 自动转换
 * - chat      → [responses, messages]：上游只支持 responses API（xAI/Codex
 *   native_responses，由 adapter 的 createChatViaResponses 转换），或只支持
 *   messages API（claude-native/anthropic-compatible，由 chat-via-messages 转换）
 */
function resolveEndpoints(
  supported: Array<ModelEndpoint>,
  requested: ModelEndpoint | undefined,
): { endpoints: Array<ModelEndpoint>; translated: boolean } | null {
  if (!requested) return { endpoints: supported, translated: false }
  if (supported.includes(requested)) {
    return { endpoints: [requested], translated: false }
  }
  const fallbackCandidates: Partial<
    Record<ModelEndpoint, Array<ModelEndpoint>>
  > = {
    responses: ["chat"],
    messages: ["chat"],
    chat: ["responses", "messages"],
  }
  for (const candidate of fallbackCandidates[requested] ?? []) {
    if (supported.includes(candidate)) {
      return { endpoints: [candidate], translated: true }
    }
  }
  return null
}

/**
 * 列出所有 connections 中可暴露给客户端的 publicId 与 alias 集合。
 * 用于聚合到 `/v1/models` 响应中。
 */
export function listExposedPublicModels(
  connections: Array<ProviderConnection> = listProviderConnections(),
): Array<{
  publicId: string
  connectionId: string
  endpoints: Array<ModelEndpoint>
  pickerEnabled: boolean
  pickerCategory?: string
  name?: string
  vendor?: string
}> {
  const out: Array<{
    publicId: string
    connectionId: string
    endpoints: Array<ModelEndpoint>
    pickerEnabled: boolean
    pickerCategory?: string
    name?: string
    vendor?: string
  }> = []
  for (const connection of connections) {
    if (!connection.enabled) continue
    refreshConnectionAvailability(connection)
    for (const model of connection.models ?? []) {
      if (!model.enabled) continue
      const ids = [model.publicId, ...(model.aliases ?? [])]
      for (const id of ids) {
        out.push({
          publicId: id,
          connectionId: connection.id,
          endpoints: model.endpoints,
          pickerEnabled: model.pickerEnabled ?? true,
          pickerCategory: model.pickerCategory,
          name: model.name,
          vendor: model.vendor,
        })
      }
    }
  }
  return [...out, ...getExposedAliasEntries(out, connections)]
}

function accountModelId(model: AccountModel): string {
  return model.id
}

function matchesAccountModel(
  account: Account,
  model: AccountModel,
  requestedId: string,
): boolean {
  const nativeId = accountModelId(model)
  const aliases = buildAccountModelAliases(account, nativeId)
  const normalized = requestedId.toLowerCase()
  return aliases.some((alias) => alias.toLowerCase() === normalized)
}
