/**
 * Failover 时的候选轮转:在请求失败后切换到下一个 RouteTarget。
 *
 * 原位于 request-admission.ts。内聚上这三个函数只依赖
 * buildRouteTargets / selectRouteTarget / connection 查询,与准入
 * (鉴权/门禁/审批)无关;执行层(direct dispatch / WS handler)需要它们,
 * 因此下沉到 route-target,消除执行层对准入层的反向依赖。
 */

import type {
  ApiCredential,
  ModelEndpoint,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"

import {
  findCredential,
  getProviderConnection,
  isAccountManagedProtocol,
} from "~/lib/provider-connections"

import { buildRouteTargets } from "./build"
import { resolveModelRouting } from "./model-reference"
import { selectRouteTarget } from "./select"

/**
 * 在请求失败时尝试切换到下一个候选 RouteTarget。
 *
 * When session affinity is enabled, the rebinding options force a new pick
 * and update the session → credential map (CPA failover behavior).
 */
export function switchToNextRouteTarget(
  _current: RouteTarget,
  modelId: string,
  endpoint: ModelEndpoint,
  exclude: Set<string>,
  session?: { sessionId?: string; fallbackSessionId?: string },
): RouteTarget | null {
  const routing = resolveModelRouting(modelId)
  const candidates = buildRouteTargets({
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    aliasRestriction: routing.aliasRestriction,
    endpoint,
  })
  return selectRouteTarget(candidates, {
    exclude,
    sessionId: session?.sessionId,
    fallbackSessionId: session?.fallbackSessionId,
    rebindAffinity: true,
  })
}

/**
 * WS-only same-protocol account rotation selector for in-round Responses
 * failover. Deliberately separate from `switchToNextRouteTarget` (which the
 * HTTP dispatch path and its cross-system failover test depend on), because
 * this selector adds three WS-specific constraints:
 *
 *   1. Forwards `routing.connectionId` so an explicit `connectionId/model` pin
 *      is honored — never switches to a different connection (returns null
 *      once the pinned connection's account is exhausted).
 *   2. Keeps the same protocol as the initial target — a bare model resolving
 *      to both codex + xAI must not cross protocols mid-turn.
 *   3. Only returns account-managed candidates (*-native protocols), since
 *      rotation resolves the connection and calls
 *      `createResponses({ connection, credential })`.
 *
 * Returns null when no other same-protocol, account-managed candidate remains
 * (excluding those already in `tried`).
 */
export function selectNextResponsesWsTarget(
  initialTarget: RouteTarget,
  modelId: string,
  tried: Set<string>,
  session?: { sessionId?: string; fallbackSessionId?: string },
): RouteTarget | null {
  const routing = resolveModelRouting(modelId)
  const candidates = buildRouteTargets({
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    connectionId: routing.connectionId,
    aliasRestriction: routing.aliasRestriction,
    endpoint: "responses",
  }).filter(
    (candidate) =>
      candidate.protocol === initialTarget.protocol
      && isAccountManagedProtocol(candidate.protocol),
  )
  return selectRouteTarget(candidates, {
    exclude: tried,
    sessionId: session?.sessionId,
    fallbackSessionId: session?.fallbackSessionId,
    rebindAffinity: true,
  })
}

/**
 * 把 RouteTarget 解析为 ProviderAdmission 信息。
 *
 * 批次 3 后统一从 getProviderConnection 查找真实 connection/credential。
 * Phase 2e：不再派生 account 字段。
 *
 * 返回 null 表示无法解析(调用方应抛出原始错误)。
 */
export function resolveConnectionFromTarget(target: RouteTarget): {
  connection: ProviderConnection
  credential: ApiCredential
} | null {
  // 批次 3：target.account 已删除，统一走 getProviderConnection
  const connection = getProviderConnection(target.connectionId)
  if (!connection) return null
  const found = findCredential(target.connectionId, target.credentialId)
  if (!found) return null
  return { connection, credential: found.credential }
}
