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
  DEFAULTS,
  isCredentialAvailable,
  listProviderConnections,
  refreshConnectionAvailability,
  type ApiCredential,
  type ModelEndpoint,
  type ModelMapping,
  type ProviderConnection,
  type RouteTarget,
} from "~/lib/provider-connections"
import { readAccountLegacyMetadata } from "~/lib/provider-connections/connection-metadata"

function safeCredentials(connection: ProviderConnection): Array<ApiCredential> {
  const credentials = (connection as { credentials?: unknown }).credentials
  return Array.isArray(credentials) ? (credentials as Array<ApiCredential>) : []
}

function pushEndpointTargets(
  out: Array<RouteTarget>,
  endpoints: Array<ModelEndpoint>,
  model: ModelMapping,
  connection: ProviderConnection,
  credential: ApiCredential,
): void {
  for (const endpoint of endpoints) {
    if (!model.endpoints.includes(endpoint)) continue
    out.push({
      connectionId: connection.id,
      connectionName: connection.name,
      protocol: connection.protocol,
      credentialId: credential.id,
      publicModelId: model.publicId,
      upstreamModelId: model.upstreamId,
      endpoint,
      connectionPriority: connection.priority,
      connectionWeight: connection.weight ?? DEFAULTS.CONNECTION_WEIGHT,
      credentialPriority: credential.priority ?? DEFAULTS.CREDENTIAL_PRIORITY,
      credentialWeight: credential.weight ?? DEFAULTS.CREDENTIAL_WEIGHT,
    })
  }
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
}

export function buildRouteTargets(
  options: BuildRouteTargetsOptions = {},
): Array<RouteTarget> {
  const onlyAvailable = options.onlyAvailable ?? true
  const rawConnections = options.connections ?? listProviderConnections()
  // 批次 2：account-derived connections 已在 stateRoot.connections 中，
  // 但它们也会通过 state.accounts → accountToConnection 作为虚拟 connection 加入。
  // 为避免重复，从 baseConnections 中排除 account-derived connections。
  const baseConnections = rawConnections.filter(
    (conn) => !readAccountLegacyMetadata(conn),
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
    if (onlyAvailable && !connection.enabled) continue

    const credentials = safeCredentials(connection)
    refreshConnectionAvailability({ ...connection, credentials })

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
          connectionPriority: connection.priority,
          connectionWeight: connection.weight ?? DEFAULTS.CONNECTION_WEIGHT,
          credentialPriority:
            credentials[0]?.priority ?? DEFAULTS.CREDENTIAL_PRIORITY,
          credentialWeight:
            credentials[0]?.weight ?? DEFAULTS.CREDENTIAL_WEIGHT,
        })
      }
      continue
    }

    const models = connection.models ?? []
    for (const model of models) {
      if (!model.enabled) continue
      // account-backed 虚拟 connection 走 resolveEndpoints(支持 responses/messages → chat fallback);
      // 普通 connection 直接用 endpoint 包含关系过滤(无 fallback)。
      if (account) {
        const ep = resolveEndpoints(model.endpoints, options.endpoint)
        if (!ep) continue
      } else if (
        options.endpoint
        && !model.endpoints.includes(options.endpoint)
      ) {
        continue
      }
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
        // upstreamModelId 用 model.upstreamId(已剥离前缀),并支持 responses/messages → chat fallback
        if (account) {
          const ep = resolveEndpoints(model.endpoints, options.endpoint)
          if (!ep) continue
          for (const endpoint of ep) {
            targets.push({
              connectionId: connection.id,
              connectionName: connection.name,
              protocol: connection.protocol,
              credentialId: credential.id,
              publicModelId: options.publicModelId ?? model.publicId,
              upstreamModelId: model.upstreamId,
              endpoint,
              connectionPriority: connection.priority,
              connectionWeight: connection.weight ?? DEFAULTS.CONNECTION_WEIGHT,
              credentialPriority:
                credential.priority ?? DEFAULTS.CREDENTIAL_PRIORITY,
              credentialWeight: credential.weight ?? DEFAULTS.CREDENTIAL_WEIGHT,
            })
          }
        } else {
          const endpoints =
            options.endpoint ? [options.endpoint] : model.endpoints
          pushEndpointTargets(targets, endpoints, model, connection, credential)
        }
      }
    }
  }

  return targets
}

/** 将 ModelMapping 转回 AccountModel 形态(仅用于 matchesAccountModel 的别名匹配)。 */
function modelToAccountModel(model: ModelMapping): AccountModel {
  // AccountModel.id 与 ModelMapping.publicId 对应;
  // supportedEndpoints 用空数组占位,matchesAccountModel 只用 id/buildAccountModelAliases
  return {
    id: model.publicId,
    name: model.name ?? model.publicId,
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
 *
 * fallback 映射：
 * - responses → chat：上游只支持 chat completions 但客户端用 responses API
 * - messages  → chat：上游只支持 chat completions 但客户端用 anthropic messages API
 * - chat      → responses：上游只支持 responses API（如 xAI/Codex native_responses），
 *   由 protocol adapter 的 createChatViaResponses 自动转换
 */
function resolveEndpoints(
  supported: Array<ModelEndpoint>,
  requested: ModelEndpoint | undefined,
): Array<ModelEndpoint> | null {
  if (!requested) return supported
  if (supported.includes(requested)) return [requested]
  const fallbackMap: Partial<Record<ModelEndpoint, ModelEndpoint>> = {
    responses: "chat",
    messages: "chat",
    chat: "responses",
  }
  const fallback = fallbackMap[requested]
  if (fallback && supported.includes(fallback)) return [fallback]
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
    refreshConnectionAvailability({
      ...connection,
      credentials: safeCredentials(connection),
    })
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
  return out
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
