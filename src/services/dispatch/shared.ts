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
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { HTTPError } from "~/lib/error"

import { executeWithFailover } from "./failover"

export interface ChatDispatchOptions {
  routeKind: "chat"
  payload: ChatCompletionsPayload
  c?: import("hono").Context
  executionContext?: RequestExecutionContext
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
      // Step B 后 admission 始终携带 connection/credential;
      // account-backed 路径下由 accountToConnection 构造虚拟对象。
      const { connection: conn, credential: cred } = current

      if (routeKind === "chat") {
        if (!adapter?.createChatCompletions) {
          throw new HTTPError(
            `Protocol "${target.protocol}" does not support chat completions`,
            new Response("Not Implemented", { status: 501 }),
          )
        }
        return adapter
          .createChatCompletions({
            target,
            connection: conn,
            credential: cred,
            payload,
            signal,
            ctx: {
              initiator: current.initiator,
              c: options.c,
              ...options.executionContext,
            },
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
        .createMessages({
          target,
          connection: conn,
          credential: cred,
          payload,
          signal,
          ctx: {
            forwardedHeaders: options.forwardedHeaders,
            initiator: current.initiator,
          },
        })
        .then((r) => r as unknown as DispatchResult)
    },
  })
}
