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
import { createChatCompletions } from "~/services/copilot/create-chat-completions"

import { executeWithFailover } from "./failover"

export type ChatDispatchResult =
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }

export async function dispatchChatCompletions(
  payload: ChatCompletionsPayload,
  admission: RequestAdmission,
  signal?: AbortSignal,
  c?: Context,
): Promise<ChatDispatchResult> {
  if (admission.kind === "legacy") {
    const result = await createChatCompletions(payload, {
      account: admission.account,
      signal,
      initiatorOverride: admission.initiator,
      c,
    })
    return result as ChatDispatchResult
  }

  return await dispatchViaConnection(payload, admission, signal, c)
}

async function dispatchViaConnection(
  payload: ChatCompletionsPayload,
  admission: Extract<RequestAdmission, { kind: "connection" }>,
  signal?: AbortSignal,
  c?: Context,
): Promise<ChatDispatchResult> {
  return await executeWithFailover({
    payload,
    admission,
    signal,
    routeKind: "chat",
    logPrefix: "[dispatch/chat]",
    execute: async (adapter, current) => {
      if (!adapter?.createChatCompletions) {
        throw new HTTPError(
          `Protocol "${current.connection.protocol}" does not support chat completions`,
          new Response("Not Implemented", { status: 501 }),
        )
      }
      const result = await adapter.createChatCompletions(
        current.target,
        current.connection,
        current.credential,
        payload,
        signal,
        { initiator: current.initiator, c },
      )
      return {
        accountId: result.credentialId,
        response: result.response,
      } as ChatDispatchResult
    },
  })
}
