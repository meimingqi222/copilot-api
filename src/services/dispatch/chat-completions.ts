/**
 * Chat Completions 统一调度器。
 */

import type { Context } from "hono"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

import { HTTPError } from "~/lib/error"
import { type RequestAdmission } from "~/lib/request-admission"

import {
  executeWithFailover,
  legacyPlaceholderConn,
  legacyPlaceholderCred,
} from "./failover"

export type ChatDispatchResult =
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }

export async function dispatchChatCompletions(
  payload: ChatCompletionsPayload,
  admission: RequestAdmission,
  signal?: AbortSignal,
  c?: Context,
): Promise<ChatDispatchResult> {
  return await executeWithFailover({
    payload,
    admission,
    signal,
    routeKind: "chat",
    logPrefix: "[dispatch/chat]",
    execute: (adapter, target, current) => {
      if (!adapter?.createChatCompletions) {
        throw new HTTPError(
          `Protocol "${target.protocol}" does not support chat completions`,
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
        .createChatCompletions(target, conn, cred, payload, signal, {
          initiator: current.initiator,
          c,
        })
        .then(
          (result) =>
            ({
              accountId: result.credentialId,
              response: result.response,
            }) as ChatDispatchResult,
        )
    },
  })
}
