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

import { dispatchRequest } from "./shared"

export type ChatDispatchResult =
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }

export async function dispatchChatCompletions(
  payload: ChatCompletionsPayload,
  admission: RequestAdmission,
  signal?: AbortSignal,
  c?: Context,
): Promise<ChatDispatchResult> {
  const result = await dispatchRequest(
    { routeKind: "chat", payload, c },
    admission,
    signal,
  )
  return {
    accountId: result.credentialId,
    response: result.response,
  } as ChatDispatchResult
}
