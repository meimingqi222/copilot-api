/**
 * 把 ProviderConnection + ApiCredential + ModelMapping 和 legacy Account
 * 展平为可调度的 RouteTarget。
 *
 * 输出按 (publicId, endpoint) 维度组织,选择器在此基础上做优先级与权重判定。
 */

import type { Account, AccountModel } from "~/lib/accounts"
import type { ProviderId } from "~/lib/provider-config"

import { isAccountAvailable } from "~/lib/account-availability"
import { buildAccountModelAliases, getAccountModelPrefix } from "~/lib/accounts"
import {
  DEFAULTS,
  isCredentialAvailable,
  listProviderConnections,
  refreshConnectionAvailability,
  type ApiCredential,
  type ModelEndpoint,
  type ModelMapping,
  type ProviderProtocol,
  type ProviderConnection,
  type RouteTarget,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"

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
  const connections = options.connections ?? listProviderConnections()

  const targets: Array<RouteTarget> = []

  for (const connection of connections) {
    if (options.connectionId && connection.id !== options.connectionId) {
      continue
    }
    if (onlyAvailable && !connection.enabled) continue
    const credentials = safeCredentials(connection)
    refreshConnectionAvailability({ ...connection, credentials })

    const models = connection.models ?? []
    for (const model of models) {
      if (!model.enabled) continue
      if (options.endpoint && !model.endpoints.includes(options.endpoint)) {
        continue
      }
      if (
        options.publicModelId
        && !matchesPublicModelId(model, options.publicModelId)
      ) {
        continue
      }

      for (const credential of credentials) {
        if (onlyAvailable && !isCredentialAvailable(credential)) continue

        const endpoints =
          options.endpoint ? [options.endpoint] : model.endpoints
        pushEndpointTargets(targets, endpoints, model, connection, credential)
      }
    }
  }

  // Account candidates (legacy providers)
  if (!options.connectionId) {
    const accounts = options.accounts ?? state.accounts
    for (const account of accounts) {
      if (onlyAvailable && !isAccountAvailable(account)) continue
      if (
        options.legacyProvider
        && account.provider !== options.legacyProvider
      ) {
        continue
      }
      if (options.accountPrefix) {
        const prefix = getAccountModelPrefix(account).toLowerCase()
        if (prefix !== options.accountPrefix.toLowerCase()) {
          continue
        }
      }

      const protocol = accountProtocol(account.provider)
      if (!protocol) continue

      // availableModels === undefined：模型列表尚未加载，接受所有模型请求（与 account-selection.ts 保持一致）
      // availableModels === []：已加载但为空，跳过此账户
      if (
        account.availableModels !== undefined
        && account.availableModels.length === 0
      ) {
        continue
      }

      if (account.availableModels === undefined) {
        // 尚未加载：为请求的模型生成通配 target（publicModelId 为空则不生成）
        if (!options.publicModelId) continue
        const ep =
          options.endpoint ?
            [options.endpoint]
          : (["chat"] as Array<ModelEndpoint>)
        for (const endpoint of ep) {
          targets.push({
            connectionId: account.id,
            connectionName: account.label,
            protocol,
            credentialId: account.id,
            publicModelId: options.publicModelId,
            upstreamModelId: options.publicModelId,
            endpoint,
            connectionPriority: account.priority,
            connectionWeight: DEFAULTS.CONNECTION_WEIGHT,
            credentialPriority: DEFAULTS.CREDENTIAL_PRIORITY,
            credentialWeight: DEFAULTS.CREDENTIAL_WEIGHT,
            account,
          })
        }
        continue
      }

      for (const model of account.availableModels) {
        const endpoints = accountModelEndpoints(model)
        const modelId = accountModelId(model)

        if (!modelId) continue

        if (
          options.publicModelId
          && !matchesAccountModel(account, model, options.publicModelId)
        ) {
          continue
        }

        const ep = resolveEndpoints(endpoints, options.endpoint)
        if (!ep) continue
        for (const endpoint of ep) {
          targets.push({
            connectionId: account.id,
            connectionName: account.label,
            protocol,
            credentialId: account.id,
            publicModelId: options.publicModelId ?? modelId,
            upstreamModelId: modelId,
            endpoint,
            connectionPriority: account.priority,
            connectionWeight: DEFAULTS.CONNECTION_WEIGHT,
            credentialPriority: DEFAULTS.CREDENTIAL_PRIORITY,
            credentialWeight: DEFAULTS.CREDENTIAL_WEIGHT,
            account,
          })
        }
      }
    }
  }

  return targets
}

/**
 * 根据请求的 endpoint 从模型支持的 endpoint 列表中解析出实际执行的 endpoint 列表。
 * responses/messages 不支持时可 fallback 到 chat（语义等价）；embeddings 不做 fallback。
 * 返回 null 表示该模型不支持此 endpoint，应跳过。
 */
function resolveEndpoints(
  supported: Array<ModelEndpoint>,
  requested: ModelEndpoint | undefined,
): Array<ModelEndpoint> | null {
  if (!requested) return supported
  if (supported.includes(requested)) return [requested]
  // responses -> chat 是语义等价的 fallback（同为 chat completions 协议）
  const fallbackMap: Partial<Record<ModelEndpoint, ModelEndpoint>> = {
    responses: "chat",
    messages: "chat",
  }
  const fallback = fallbackMap[requested]
  if (fallback && supported.includes(fallback)) return [fallback]
  return null
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

function accountProtocol(provider: string): ProviderProtocol | undefined {
  switch (provider) {
    case "copilot": {
      return "copilot-native"
    }
    case "codebuff": {
      return "codebuff-native"
    }
    case "windsurf": {
      return "windsurf-native"
    }
    case "mimo-aistudio": {
      return "mimo-native"
    }
    case "codex": {
      return "codex-native"
    }
    case "claude": {
      return "claude-native"
    }
    case "antigravity": {
      return "antigravity-native"
    }
    case "kimi": {
      return "kimi-native"
    }
    case "xai": {
      return "xai-native"
    }
    default: {
      return undefined
    }
  }
}

function accountModelEndpoints(model: AccountModel): Array<ModelEndpoint> {
  const eps: Array<ModelEndpoint> = []
  for (const ep of model.supportedEndpoints) {
    if (ep.includes("chat/completions")) eps.push("chat")
    else if (ep.includes("messages")) eps.push("messages")
    else if (ep.includes("responses")) eps.push("responses")
    else if (ep.includes("embeddings")) eps.push("embeddings")
    else if (ep.includes("images")) eps.push("images")
    else if (ep.includes("videos")) eps.push("videos")
  }
  return eps.length > 0 ? eps : ["chat"]
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
