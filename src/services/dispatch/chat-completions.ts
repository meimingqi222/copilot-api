/**
 * Chat Completions 统一调度器。
 */

import type { Context } from "hono"

import type { RequestAdmission } from "~/lib/request-admission"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import type { DispatchIdentity } from "./shared"

import { dispatchRequest } from "./shared"

export type ChatDispatchResult =
  | {
      accountId: string
      response: AsyncIterable<CopilotStreamEvent>
      identity: DispatchIdentity
    }
  | {
      accountId: string
      response: ChatCompletionResponse
      identity: DispatchIdentity
    }

export async function dispatchChatCompletions(
  payload: ChatCompletionsPayload,
  admission: RequestAdmission,
  signal?: AbortSignal,
  c?: Context,
  executionContext?: RequestExecutionContext,
): Promise<ChatDispatchResult> {
  const result = await dispatchRequest(
    { routeKind: "chat", payload, c, executionContext },
    admission,
    signal,
  )
  return {
    accountId: result.identity.ownerId,
    response: result.response,
    identity: result.identity,
  } as ChatDispatchResult
}
