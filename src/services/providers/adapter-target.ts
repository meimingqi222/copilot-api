/**
 * 直调 adapter 时的 RouteTarget 构造(Phase 2e,替代已删除的
 * services/providers/delegate.ts 中的 buildAccountTarget)。
 *
 * 与 route-target/build.ts 的调度 target 不同:这里从已解析的
 * (connection, credential) 出发构造单次调用所需的 target,
 * 供 wrapper 层(create-chat-completions 等)直调 protocol adapter。
 */

import type {
  ApiCredential,
  ModelEndpoint,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"

import { DEFAULTS } from "~/lib/provider-connections"

export function buildDirectAdapterTarget({
  connection,
  credential,
  payloadModel,
  nativeModelId,
  endpoint,
}: {
  connection: ProviderConnection
  credential: ApiCredential
  payloadModel: string
  nativeModelId: string
  endpoint: ModelEndpoint
}): RouteTarget {
  return {
    connectionId: connection.id,
    connectionName: connection.name,
    protocol: connection.protocol,
    credentialId: credential.id,
    publicModelId: payloadModel,
    upstreamModelId: nativeModelId,
    endpoint,
    connectionPriority: connection.priority,
    connectionWeight: connection.weight ?? DEFAULTS.CONNECTION_WEIGHT,
    credentialPriority: credential.priority ?? DEFAULTS.CREDENTIAL_PRIORITY,
    credentialWeight: credential.weight ?? DEFAULTS.CREDENTIAL_WEIGHT,
  }
}
