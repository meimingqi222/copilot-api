import type { Context } from "hono"

import consola from "consola"

import type { Account, AccountProvider } from "~/lib/accounts"
import type { ProtectedRouteKind } from "~/lib/protected-routes"
import type {
  ApiCredential,
  ProviderConnection,
  ProviderProtocol,
  RouteTarget,
} from "~/lib/provider-connections"

import { parseModelReference } from "~/lib/accounts"
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
  resolveModelRouting,
  selectRouteTarget,
} from "~/lib/route-target"
import { state } from "~/lib/state"
import { isUserAllowedModel } from "~/lib/users"

/**
 * 路由解析结果。
 *
 * - `kind: "account"`: Account-based target (Copilot/Codebuff/Windsurf/Mimo native adapter)。
 * - `kind: "provider"`: ProviderConnection-based target (OpenAI/Anthropic-compatible adapter)。
 *
 * 统一由 `buildRouteTargets` 生成候选池,`selectRouteTarget` 按优先级/权重选取。
 */
export type RequestAdmission = AccountAdmission | ProviderAdmission

export interface AccountAdmission {
  kind: "account"
  account: Account
  target: RouteTarget
  initiator?: "agent" | "user"
}

export interface ProviderAdmission {
  kind: "provider"
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  initiator?: "agent" | "user"
}

const ACCOUNT_PROTOCOLS: Record<AccountProvider, ProviderProtocol> = {
  copilot: "copilot-native",
  codebuff: "codebuff-native",
  windsurf: "windsurf-native",
  "mimo-aistudio": "mimo-native",
  codex: "codex-native",
  claude: "claude-native",
  antigravity: "antigravity-native",
  kimi: "kimi-native",
  xai: "xai-native",
}

export function getAccountProtocol(account: Account): ProviderProtocol {
  return ACCOUNT_PROTOCOLS[account.provider]
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
  c.set("model", options.model)
  enforceUserModelAccess(c, options.model)

  try {
    checkProtectedRouteGuard(c, {
      routeKind: options.routeKind,
      model: options.model,
      maxTokens: options.maxTokens,
      stream: options.stream,
      messageContent: options.messageContent,
      provider: inferProviderFromModel(options.model),
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
  c.set("guardInitiator", initiator)

  const routing = resolveModelRouting(options.model)
  const candidates = buildRouteTargets({
    connectionId: routing.connectionId,
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    endpoint: options.endpoint,
  })

  const target = selectRouteTarget(candidates)
  if (!target) {
    throw new HTTPError(
      "No available route for model",
      new Response("Rate limited", { status: 429 }),
    )
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  if (target.account) {
    return {
      kind: "account",
      account: target.account,
      target,
      initiator,
    }
  }

  // 类型安全检查：确保 connectionId 和 credentialId 存在
  if (!target.connectionId || !target.credentialId) {
    throw new HTTPError(
      "Invalid route target: missing connection or credential ID",
      new Response("Bad Request", { status: 400 }),
    )
  }

  const connection = getProviderConnection(target.connectionId)
  const found = findCredential(target.connectionId, target.credentialId)
  if (!connection || !found) {
    throw new HTTPError(
      "Route target resolution failed",
      new Response("Service Unavailable", { status: 503 }),
    )
  }
  return {
    kind: "provider",
    target,
    connection,
    credential: found.credential,
    initiator,
  }
}

function enforceUserModelAccess(c: Context, model: string): void {
  const user = c.get("user")
  if (!user || isUserAllowedModel(user, model)) {
    return
  }

  throw new HTTPError(
    `Model "${model}" is not enabled for user "${user.username}"`,
    new Response("Forbidden", { status: 403 }),
  )
}

/**
 * 在请求失败时尝试切换到下一个候选 RouteTarget。
 * 支持 Connection 和 Account 两种 target。
 */
export function switchToNextRouteTarget(
  _current: RouteTarget,
  modelId: string,
  endpoint: ModelEndpoint,
  exclude: Set<string>,
): RouteTarget | null {
  const routing = resolveModelRouting(modelId)
  const candidates = buildRouteTargets({
    legacyProvider: routing.legacyProvider,
    accountPrefix: routing.accountPrefix,
    publicModelId: routing.modelId,
    endpoint,
  })
  return selectRouteTarget(candidates, { exclude })
}

/**
 * 把 RouteTarget 解析为 ProviderAdmission 或 null (Account target)。
 */
export function resolveConnectionFromTarget(target: RouteTarget): {
  connection: ProviderConnection
  credential: ApiCredential
} | null {
  const connection = getProviderConnection(target.connectionId)
  if (!connection) return null
  const found = findCredential(target.connectionId, target.credentialId)
  if (!found) return null
  return { connection, credential: found.credential }
}

/** Infer provider ID from model name (for guard auto-detection exemption). */
function inferProviderFromModel(model: string): string | undefined {
  const parsed = parseModelReference(model)
  if (parsed.provider) return parsed.provider
  // Check connection-level prefix
  const slashIdx = model.indexOf("/")
  if (slashIdx > 0) {
    const maybeConn = model.slice(0, slashIdx)
    const conn = getProviderConnection(maybeConn)
    if (conn) return conn.protocol === "copilot-native" ? "copilot" : maybeConn
  }
  return undefined
}
