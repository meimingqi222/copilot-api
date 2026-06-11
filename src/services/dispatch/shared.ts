/**
 * Shared dispatch logic for chat-completions and messages routes.
 */

import type { RouteTarget } from "~/lib/provider-connections"
import type { RequestAdmission } from "~/lib/request-admission"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type {
  AdapterChatResult,
  AdapterMessagesResult,
  AnthropicMessagesPayload,
} from "~/services/protocols"

import { HTTPError } from "~/lib/error"

import {
  executeWithFailover,
  legacyPlaceholderConn,
  legacyPlaceholderCred,
} from "./failover"

export interface ChatDispatchOptions {
  routeKind: "chat"
  payload: ChatCompletionsPayload
  c?: import("hono").Context
}

export interface MessagesDispatchOptions {
  routeKind: "messages"
  payload: AnthropicMessagesPayload
  forwardedHeaders?: Record<string, string | undefined>
}

export type DispatchOptions = ChatDispatchOptions | MessagesDispatchOptions

export type DispatchResult = AdapterChatResult | AdapterMessagesResult

export async function dispatchRequest(
  options: DispatchOptions,
  admission: RequestAdmission,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  const { routeKind, payload } = options

  return await executeWithFailover({
    payload,
    admission,
    signal,
    routeKind,
    logPrefix: `[dispatch/${routeKind}]`,
    execute: (adapter, target: RouteTarget, current) => {
      const conn =
        current.kind === "provider" ?
          current.connection
        : legacyPlaceholderConn(target)
      const cred =
        current.kind === "provider" ?
          current.credential
        : legacyPlaceholderCred(target)

      if (routeKind === "chat") {
        if (!adapter?.createChatCompletions) {
          throw new HTTPError(
            `Protocol "${target.protocol}" does not support chat completions`,
            new Response("Not Implemented", { status: 501 }),
          )
        }
        return adapter
          .createChatCompletions(target, conn, cred, payload, signal, {
            initiator: current.initiator,
            c: options.c,
          })
          .then((r) => r as unknown as DispatchResult)
      }

      if (!adapter?.createMessages) {
        throw new HTTPError(
          `Protocol "${target.protocol}" does not support /messages`,
          new Response("Not Implemented", { status: 501 }),
        )
      }
      return adapter
        .createMessages(target, conn, cred, payload, signal, {
          forwardedHeaders: options.forwardedHeaders,
          initiator: current.initiator,
        })
        .then((r) => r as unknown as DispatchResult)
    },
  })
}
