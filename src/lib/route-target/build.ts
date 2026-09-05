/**
 * 把 ProviderConnection + ApiCredential + ModelMapping 展平为可调度的 RouteTarget。
 *
 * 输出按 (publicId, endpoint) 维度组织,选择器在此基础上做优先级与权重判定。
 *
 * Step D 收尾(Phase 1):account-managed connections 已常驻
 * stateRoot.connections,不再经由 `state.accounts → accountToConnection`
 * 派生虚拟 connection —— 所有 connection 走单一候选池路径。
 *
 * 通配 target 语义(D.2/D.3):
 * - account-managed connection 且 conn.models === undefined/null(尚未加载)
 *   → 为请求的模型生成通配 target(兜底)
 * - conn.models === [](已加载但为空) → 跳过(不生成任何 target)
 * - conn.models 非空 → 逐模型生成专用 target
 * - 普通 connection(*-compatible)models 未加载时不生成 target(保持现行为)
 */

import type { ProviderId } from "~/lib/provider-config"

import {
  buildConnectionModelAliases,
  connectionMatchesAliasRestriction,
  getExposedAliasEntries,
  type ModelAliasRestriction,
} from "~/lib/model-aliases"
import {
  DEFAULTS,
  accountManagedModelPrefix,
  accountManagedProvider,
  getConnectionRoutability,
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
  /** 仅匹配指定 legacy provider 的 account-managed connection。 */
  legacyProvider?: ProviderId
  /** 仅匹配指定 modelPrefix 的 account-managed connection。 */
  accountPrefix?: string
  /** Restrict candidates to the scope of a matched global alias rule. */
  aliasRestriction?: ModelAliasRestriction
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
    if (
      !connectionMatchesAliasRestriction(connection, options.aliasRestriction)
    ) {
      continue
    }
    if (onlyAvailable && !connection.enabled) continue
    if (
      options.legacyProvider
      && !connectionMatchesProvider(connection, options.legacyProvider)
    ) {
      continue
    }
    if (
      options.accountPrefix
      && !connectionMatchesPrefix(connection, options.accountPrefix)
    ) {
      continue
    }

    const credentials = safeCredentials(connection)
    // 直接在原 connection 上 refresh,让 stateRoot 中的 credential
    // 状态被正确恢复(已过期的 cooldown / quota_exhausted → ready)。
    refreshConnectionAvailability(connection)

    const accountManaged = isAccountManagedConnection(connection)

    // account-managed 可用性预过滤(镜像原 isAccountAvailable 账户级门禁:
    // credential.enabled / authStatus / 限流器冷却 / 配额耗尽)
    if (
      onlyAvailable
      && accountManaged
      && !isAccountManagedConnectionRoutable(connection)
    )
      continue

    // account-managed connection 尚未加载模型(undefined/null)→ 通配 target
    if (accountManaged && modelsNotLoaded(connection)) {
      // 尚未加载:为请求的模型生成通配 target(publicModelId 为空则不生成)
      if (!options.publicModelId) continue
      const ep: Array<ModelEndpoint> =
        options.endpoint ?
          [options.endpoint]
        : (["chat"] as Array<ModelEndpoint>)
      for (const endpoint of ep) {
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
      // account-backed 和普通 connection 都走 resolveEndpoints,使请求的
      // endpoint(如 "messages")可以回退到 connection 实际支持的另一个
      // endpoint(如 "chat"),由 dispatch 层做跨协议翻译。
      const resolved = resolveEndpoints(model.endpoints, options.endpoint)
      if (!resolved) continue
      if (options.publicModelId) {
        // 对 account-managed connection,使用 prefix 别名匹配;
        // 对普通 connection,使用 publicId/aliases 匹配
        const matched =
          accountManaged ?
            matchesConnectionModel(connection, model, options.publicModelId)
          : matchesPublicModelId(model, options.publicModelId)
        if (!matched) continue
      }

      for (const credential of credentials) {
        if (onlyAvailable && !isCredentialAvailable(credential)) continue

        // account-managed connection:保留请求时的 publicModelId(可能带
        // provider/自定义前缀),upstreamModelId 用 model.upstreamId(已剥离前缀)
        const publicModelId =
          accountManaged ?
            (options.publicModelId ?? model.publicId)
          : model.publicId
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

/**
 * connection.models 是否尚未加载(undefined/null)。
 * 注意与 `[]`(已加载但为空)区分 —— 后者不生成任何 target(D.3 规则 4)。
 */
function modelsNotLoaded(connection: ProviderConnection): boolean {
  const models = (connection as { models?: unknown }).models
  return models === undefined || models === null
}

/**
 * account-managed connection 是否可参与调度。委托统一定义
 * getConnectionRoutability(布尔投影),语义见该函数注释。
 */
function isAccountManagedConnectionRoutable(
  connection: ProviderConnection,
): boolean {
  return getConnectionRoutability(connection).routable
}

/**
 * legacy provider 过滤:仅 account-managed connection 参与
 * (镜像原 account.provider !== legacyProvider → skip)。
 */
function connectionMatchesProvider(
  connection: ProviderConnection,
  legacyProvider: ProviderId,
): boolean {
  if (!isAccountManagedConnection(connection)) return false
  return accountManagedProvider(connection) === legacyProvider
}

/**
 * modelPrefix 过滤:仅 account-managed connection 参与
 * (镜像原 getAccountModelPrefix(account) !== accountPrefix → skip)。
 */
function connectionMatchesPrefix(
  connection: ProviderConnection,
  accountPrefix: string,
): boolean {
  if (!isAccountManagedConnection(connection)) return false
  return (
    accountManagedModelPrefix(connection).toLowerCase()
    === accountPrefix.toLowerCase()
  )
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

function matchesPublicModelId(model: ModelMapping, requested: string): boolean {
  const normalized = requested.toLowerCase()
  if (model.publicId.toLowerCase() === normalized) return true
  if (model.aliases?.some((alias) => alias.toLowerCase() === normalized)) {
    return true
  }
  return false
}

/**
 * account-managed connection 的模型匹配(镜像原 matchesAccountModel):
 * 用 prefix 别名集合(nativeId / prefix/nativeId / provider-nativeId)匹配。
 */
function matchesConnectionModel(
  connection: ProviderConnection,
  model: ModelMapping,
  requestedId: string,
): boolean {
  const aliases = buildConnectionModelAliases(connection, model.publicId)
  const normalized = requestedId.toLowerCase()
  return aliases.some((alias) => alias.toLowerCase() === normalized)
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
