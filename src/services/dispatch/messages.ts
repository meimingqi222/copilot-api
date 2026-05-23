/**
 * Anthropic Messages 调度器(connection 路径)。
 *
 * 仅用于 admission.kind === "connection" 且 protocol 为 anthropic-compatible
 * 的情形。Failover 策略与 chat-completions dispatcher 一致。
 */

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
  type AnthropicMessagesPayload,
} from "~/services/protocols"

export interface MessagesDispatchResult {
  accountId: string
  response: AsyncIterable<unknown> | Record<string, unknown>
}

export async function dispatchMessages(
  payload: AnthropicMessagesPayload,
  admission: ConnectionAdmission,
  signal?: AbortSignal,
  forwardedHeaders?: Record<string, string | undefined>,
): Promise<MessagesDispatchResult> {
  initializeProtocolAdapters()

  const tried = new Set<string>()
  let current = admission

  while (true) {
    const adapter = getProtocolAdapter(current.connection.protocol)
    if (!adapter?.createMessages) {
      throw new HTTPError(
        `Protocol "${current.connection.protocol}" does not support /messages`,
        new Response("Not Implemented", { status: 501 }),
      )
    }
    try {
      const result = await adapter.createMessages(
        current.target,
        current.connection,
        current.credential,
        payload,
        signal,
        { forwardedHeaders, initiator: current.initiator },
      )
      return { accountId: result.credentialId, response: result.response }
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
            "[dispatch/messages] failed to persist credential status:",
            (err as Error).message,
          )
        })
      }

      const next = switchToNextRouteTarget(
        current.target,
        payload.model,
        "messages",
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
