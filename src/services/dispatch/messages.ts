/**
 * Anthropic Messages 调度器(unified path)。
 */

import type { RouteTarget } from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { type RequestAdmission } from "~/lib/request-admission"
import { type AnthropicMessagesPayload } from "~/services/protocols"

import {
  executeWithFailover,
  legacyPlaceholderConn,
  legacyPlaceholderCred,
} from "./failover"

export interface MessagesDispatchResult {
  accountId: string
  response: AsyncIterable<unknown> | Record<string, unknown>
}

export async function dispatchMessages(
  payload: AnthropicMessagesPayload,
  admission: RequestAdmission,
  signal?: AbortSignal,
  forwardedHeaders?: Record<string, string | undefined>,
): Promise<MessagesDispatchResult> {
  return await executeWithFailover({
    payload,
    admission,
    signal,
    routeKind: "messages",
    logPrefix: "[dispatch/messages]",
    execute: (adapter, target: RouteTarget, current) => {
      if (!adapter?.createMessages) {
        throw new HTTPError(
          `Protocol "${target.protocol}" does not support /messages`,
          new Response("Not Implemented", { status: 501 }),
        )
      }
      const conn =
        current.kind === "connection" ?
          current.connection
        : legacyPlaceholderConn(target)
      const cred =
        current.kind === "connection" ?
          current.credential
        : legacyPlaceholderCred(target)
      return adapter
        .createMessages(target, conn, cred, payload, signal, {
          forwardedHeaders,
          initiator: current.initiator,
        })
        .then(
          (result) =>
            ({
              accountId: result.credentialId,
              response: result.response,
            }) as MessagesDispatchResult,
        )
    },
  })
}
