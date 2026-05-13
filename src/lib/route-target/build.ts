/**
 * 把 ProviderConnection + ApiCredential + ModelMapping 展平为可调度的 RouteTarget。
 *
 * 输出按 (publicId, endpoint) 维度组织,选择器在此基础上做优先级与权重判定。
 */

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

  return targets
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
