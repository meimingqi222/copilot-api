import consola from "consola"

import { HTTPError } from "~/lib/error"
import {
  DEFAULTS,
  markCredentialCooldown,
  persistProviderConnections,
} from "~/lib/provider-connections"
import {
  switchToNextRouteTarget,
  type ConnectionAdmission,
} from "~/lib/request-admission"
import { targetKey } from "~/lib/route-target"
import { isAbortError, shouldFailover } from "~/lib/utils"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

export interface FailoverOptions<TPayload, TResult> {
  payload: TPayload
  admission: ConnectionAdmission
  signal?: AbortSignal
  routeKind: "chat" | "messages" | "responses" | "embeddings"
  execute: (
    adapter: ReturnType<typeof getProtocolAdapter>,
    current: ConnectionAdmission,
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
  let current = admission

  while (true) {
    const adapter = getProtocolAdapter(current.connection.protocol)
    try {
      return await execute(adapter, current)
    } catch (error) {
      if (isAbortError(error)) throw error

      tried.add(targetKey(current.target))

      if (error instanceof HTTPError) {
        if (!shouldFailover(error)) throw error
      } else {
        markCredentialCooldown(current.credential, {
          retryAfterMs: DEFAULTS.COOLDOWN_NETWORK_MS,
          reason: error instanceof Error ? error.message : "network error",
        })
        await persistProviderConnections().catch((err: unknown) => {
          consola.warn(
            `${logPrefix} failed to persist credential status:`,
            (err as Error).message,
          )
        })
      }

      const next = switchToNextRouteTarget(
        current.target,
        payload.model,
        routeKind,
        tried,
      )
      if (!next) throw error
      current = {
        kind: "connection",
        target: next.target,
        connection: next.connection,
        credential: next.credential,
        initiator: current.initiator,
      }
    }
  }
}
