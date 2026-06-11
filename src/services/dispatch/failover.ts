import consola from "consola"

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"

import { markAccountRateLimited } from "~/lib/account-availability"
import { HTTPError } from "~/lib/error"
import {
  DEFAULTS,
  markCredentialCooldown,
  persistProviderConnections,
} from "~/lib/provider-connections"
import {
  switchToNextRouteTarget,
  resolveConnectionFromTarget,
  type RequestAdmission,
} from "~/lib/request-admission"
import { targetKey } from "~/lib/route-target"
import { isAbortError, shouldFailover } from "~/lib/utils"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

export interface FailoverOptions<TPayload, TResult> {
  payload: TPayload
  admission: RequestAdmission
  signal?: AbortSignal
  routeKind: "chat" | "messages" | "responses" | "embeddings"
  execute: (
    adapter: ReturnType<typeof getProtocolAdapter>,
    target: RouteTarget,
    current: RequestAdmission,
  ) => Promise<TResult>
  logPrefix?: string
}

export async function executeWithFailover<
  TPayload extends { model: string },
  TResult,
>(options: FailoverOptions<TPayload, TResult>): Promise<TResult> {
  const {
    payload,
    admission,
    routeKind,
    execute,
    logPrefix = "[dispatch]",
  } = options
  initializeProtocolAdapters()

  const tried = new Set<string>()
  let current: RequestAdmission = admission

  while (true) {
    const adapter = getProtocolAdapter(current.target.protocol)
    try {
      return await execute(adapter, current.target, current)
    } catch (error) {
      if (isAbortError(error)) throw error

      tried.add(targetKey(current.target))

      if (error instanceof HTTPError && !shouldFailover(error)) throw error

      // 添加详细的错误日志记录
      if (error instanceof HTTPError) {
        consola.warn(
          `${logPrefix} Request failed during execution: ${JSON.stringify({
            target: targetKey(current.target),
            status: error.response.status,
            retryAfter: error.response.headers.get("Retry-After"),
            message: error.message,
          })}`,
        )
      } else {
        consola.warn(
          `${logPrefix} Unexpected error during execution: ${JSON.stringify({
            target: targetKey(current.target),
            error: error instanceof Error ? error.message : String(error),
          })}`,
        )
      }

      await markCooldown(current, error, logPrefix)

      const next = switchToNextRouteTarget(
        current.target,
        payload.model,
        routeKind,
        tried,
      )
      if (!next) throw error

      const conn = resolveConnectionFromTarget(next)
      if (conn) {
        current = {
          kind: "provider",
          target: next,
          connection: conn.connection,
          credential: conn.credential,
          initiator: current.initiator,
        }
      } else if (next.account) {
        current = {
          kind: "account",
          account: next.account,
          target: next,
          initiator: current.initiator,
        }
      } else {
        throw error
      }
    }
  }
}

async function markCooldown(
  admission: RequestAdmission,
  error: unknown,
  logPrefix: string,
): Promise<void> {
  const isHttp = error instanceof HTTPError
  const status = isHttp ? error.response.status : 503

  if (admission.kind === "provider") {
    const retryAfterMs = resolveRetryAfterMs(isHttp, status)
    const reason = isHttp ? `upstream ${status}` : resolveNetworkError(error)
    markCredentialCooldown(admission.credential, { retryAfterMs, reason })
    await persistProviderConnections().catch((err: unknown) => {
      consola.warn(
        `${logPrefix} failed to persist credential status:`,
        (err as Error).message,
      )
    })
  } else if (status === 429 || !isHttp) {
    await markAccountRateLimited(
      admission.account.id,
      new Response(null, { status }),
    )
  }
}

function resolveRetryAfterMs(isHttp: boolean, status: number): number {
  if (!isHttp) return DEFAULTS.COOLDOWN_NETWORK_MS
  if (status === 429) return DEFAULTS.COOLDOWN_429_FALLBACK_MS
  return DEFAULTS.COOLDOWN_5XX_MS
}

function resolveNetworkError(error: unknown): string {
  if (error instanceof Error) return error.message
  return "network error"
}

/**
 * Legacy account 路径下，ProtocolAdapter 签名要求传入 ProviderConnection，
 * 但原生适配器（copilot-native、mimo-native 等）不使用这两个参数（标记为 _connection/_credential）。
 * 这里构造最小占位对象仅用于满足类型签名。
 */
export function legacyPlaceholderConn(target: RouteTarget): ProviderConnection {
  return {
    id: target.connectionId,
    name: target.connectionName,
    protocol: target.protocol,
    baseUrl: "",
    enabled: true,
    priority: 1,
    credentials: [],
    createdAt: Date.now(),
  }
}

export function legacyPlaceholderCred(target: RouteTarget): ApiCredential {
  return {
    id: target.credentialId,
    authMode: "bearer",
    value: "",
    enabled: true,
    status: "ready",
    createdAt: Date.now(),
  }
}
