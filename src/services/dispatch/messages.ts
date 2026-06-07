/**
 * Anthropic Messages 调度器(unified path)。
 */

import type { RequestAdmission } from "~/lib/request-admission"
import type { AnthropicMessagesPayload } from "~/services/protocols"

import { dispatchRequest, type DispatchResult } from "./shared"

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
  const result: DispatchResult = await dispatchRequest(
    { routeKind: "messages", payload, forwardedHeaders },
    admission,
    signal,
  )
  return result as unknown as MessagesDispatchResult
}
