/**
 * Anthropic Messages 调度器(connection 路径)。
 */

import { HTTPError } from "~/lib/error"
import { type ConnectionAdmission } from "~/lib/request-admission"
import { type AnthropicMessagesPayload } from "~/services/protocols"

import { executeWithFailover } from "./failover"

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
  return await executeWithFailover({
    payload,
    admission,
    signal,
    routeKind: "messages",
    logPrefix: "[dispatch/messages]",
    execute: async (adapter, current) => {
      if (!adapter?.createMessages) {
        throw new HTTPError(
          `Protocol "${current.connection.protocol}" does not support /messages`,
          new Response("Not Implemented", { status: 501 }),
        )
      }
      const result = await adapter.createMessages(
        current.target,
        current.connection,
        current.credential,
        payload,
        signal,
        { forwardedHeaders, initiator: current.initiator },
      )
      return { accountId: result.credentialId, response: result.response }
    },
  })
}
