import type { Context } from "hono"

import consola from "consola"

import type { Account } from "~/lib/accounts"
import type { ProtectedRouteKind } from "~/lib/protected-routes"
import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"

import { getAccountForModel } from "~/lib/account-selection"
import { awaitApproval } from "~/lib/approval"
import { HTTPError } from "~/lib/error"
import { resolveInitiatorWithClientHeader } from "~/lib/initiator-header"
import { checkProtectedRouteGuard } from "~/lib/protected-route-guard"
import {
  findCredential,
  getProviderConnection,
  type ModelEndpoint,
} from "~/lib/provider-connections"
import {
  buildRouteTargets,
  parseModelRef,
  selectRouteTarget,
} from "~/lib/route-target"
import { state } from "~/lib/state"

/**
 * 路由解析结果。
 *
 * - `kind: "legacy"`: 使用既有的 Account 路径,Copilot/Codebuff/Windsurf 等内置 provider。
 * - `kind: "connection"`: 使用 Provider Connection + Protocol Adapter 路径,
 *   通用 OpenAI/Anthropic-compatible 上游通过此路径调度。
 */
export type RequestAdmission = LegacyAdmission | ConnectionAdmission

export interface LegacyAdmission {
  kind: "legacy"
  account: Account
  initiator?: "agent" | "user"
}

export interface ConnectionAdmission {
  kind: "connection"
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  initiator?: "agent" | "user"
}

interface PrepareRequestAdmissionOptions {
  routeKind?: ProtectedRouteKind
  model: string
  endpoint: ModelEndpoint
  maxTokens?: number
  stream?: boolean
  inferredInitiator?: "agent" | "user"
  messageContent?: string
}

export async function prepareRequestAdmission(
  c: Context,
  options: PrepareRequestAdmissionOptions,
): Promise<RequestAdmission> {
  c.set("model" as never, options.model)

  try {
    checkProtectedRouteGuard(c, {
      routeKind: options.routeKind,
      model: options.model,
      maxTokens: options.maxTokens,
      stream: options.stream,
      messageContent: options.messageContent,
    })
  } catch (error) {
    if (error instanceof Error) {
      consola.warn(
        `Request admission failed before selection: ${JSON.stringify({
          path: c.req.path,
          model: options.model,
          routeKind: options.routeKind,
          maxTokens: options.maxTokens,
          stream: options.stream ?? false,
          errorName: error.name,
          errorMessage: error.message,
        })}`,
      )
    }
    throw error
  }

  const { initiator } = resolveInitiatorWithClientHeader(
    c,
    options.inferredInitiator ?? "user",
  )
  c.set("guardInitiator" as never, initiator)

  // 1) 尝试 Provider Connection 路径
  const connectionResult = tryResolveConnection(options.model, options.endpoint)
  if (connectionResult) {
    if (state.manualApprove) {
      await awaitApproval()
    }
    return { ...connectionResult, kind: "connection", initiator }
  }

  // 2) Fallback: legacy account 路径
  let account: Account
  try {
    account = getAccountForModel(options.model)
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.warn(
        `Request admission failed during account selection: ${JSON.stringify({
          path: c.req.path,
          model: options.model,
          routeKind: options.routeKind,
          maxTokens: options.maxTokens,
          stream: options.stream ?? false,
          status: error.response.status,
          retryAfter: error.response.headers.get("Retry-After"),
          message: error.message,
        })}`,
      )
    }
    throw error
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  return { kind: "legacy", account, initiator }
}

export function requireLegacyAdmission(
  admission: RequestAdmission,
): LegacyAdmission {
  if (admission.kind !== "legacy") {
    throw new HTTPError(
      "Provider connections are not supported on this endpoint yet",
      new Response("Not Implemented", { status: 501 }),
    )
  }
  return admission
}

function tryResolveConnection(
  modelId: string,
  endpoint: ModelEndpoint,
): {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
} | null {
  const ref = parseModelRef(modelId)
  if (ref.legacyProvider) {
    // Explicit legacy provider prefix → skip connection routing
    return null
  }

  const candidates = buildRouteTargets({
    connectionId: ref.connectionId,
    publicModelId: ref.modelId,
    endpoint,
  })

  if (candidates.length > 0) {
    const target = selectRouteTarget(candidates)
    if (target) {
      const connection = getProviderConnection(target.connectionId)
      if (!connection) return null
      const found = findCredential(target.connectionId, target.credentialId)
      if (!found) return null
      return { target, connection, credential: found.credential }
    }
  }

  // Check if any connection knows this model (ignoring availability)
  const allTargets = buildRouteTargets({
    connectionId: ref.connectionId,
    publicModelId: ref.modelId,
    endpoint,
    onlyAvailable: false,
  })
  if (allTargets.length === 0) {
    // No connection handles this model → fall through to legacy
    return null
  }

  // Connections exist but all credentials are unavailable → diagnostic error
  throwUnavailableConnectionError(allTargets)
}

/**
 * 在请求失败时尝试切换到下一个候选 RouteTarget。
 * 调用方传入已经尝试过的 (connectionId, credentialId) 集合。
 */
export function switchToNextRouteTarget(
  current: RouteTarget,
  modelId: string,
  endpoint: ModelEndpoint,
  exclude: Set<string>,
): {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
} | null {
  const ref = parseModelRef(modelId)
  const candidates = buildRouteTargets({
    connectionId: ref.connectionId ?? current.connectionId,
    publicModelId: ref.modelId,
    endpoint,
  })
  const target = selectRouteTarget(candidates, { exclude })
  if (!target) return null
  const connection = getProviderConnection(target.connectionId)
  if (!connection) return null
  const found = findCredential(target.connectionId, target.credentialId)
  if (!found) return null
  return { target, connection, credential: found.credential }
}

/**
 * 所有 connection 候选存在但均不可用时,根据聚合状态抛出诊断性 HTTPError:
 * - 全部 cooldown → 429 + Retry-After
 * - 全部 auth_error → 503 + 提示检查 key
 * - 全部 quota_exhausted → 503 + 提示配额耗尽
 * - 全部 disabled / 混合 → 503
 */
function throwUnavailableConnectionError(
  allTargets: Array<RouteTarget>,
): never {
  const statuses: Array<ApiCredential["status"] | "disabled"> = []
  let minCooldownUntil = Infinity

  for (const t of allTargets) {
    const found = findCredential(t.connectionId, t.credentialId)
    if (!found) continue
    const cred = found.credential
    const effective = !cred.enabled ? "disabled" : cred.status
    statuses.push(effective)
    if (effective === "cooldown" && cred.cooldownUntil) {
      minCooldownUntil = Math.min(minCooldownUntil, cred.cooldownUntil)
    }
  }

  if (statuses.length === 0) {
    throw new HTTPError(
      "No providers available for this model",
      new Response("Service Unavailable", { status: 503 }),
    )
  }

  if (statuses.every((s) => s === "cooldown")) {
    const retryAfterSec =
      minCooldownUntil < Infinity ?
        Math.max(0, Math.ceil((minCooldownUntil - Date.now()) / 1000))
      : 60
    const headers = new Headers({ "Retry-After": String(retryAfterSec) })
    throw new HTTPError(
      "All provider credentials are rate limited, please retry later",
      new Response("Too Many Requests", { status: 429, headers }),
    )
  }

  if (statuses.every((s) => s === "auth_error")) {
    throw new HTTPError(
      "All provider credentials have authentication errors, please check your API keys via the admin dashboard",
      new Response("Service Unavailable", { status: 503 }),
    )
  }

  if (statuses.every((s) => s === "quota_exhausted")) {
    throw new HTTPError(
      "All provider credentials have exhausted their quota",
      new Response("Service Unavailable", { status: 503 }),
    )
  }

  throw new HTTPError(
    "No available provider credentials for this model",
    new Response("Service Unavailable", { status: 503 }),
  )
}
