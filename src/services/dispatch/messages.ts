/**
 * Anthropic Messages 调度器(unified path)。
 */

import type { Context } from "hono"

import type { RequestAdmission } from "~/lib/request-admission"
import type { AnthropicMessagesPayload } from "~/services/protocols"

import type { DispatchIdentity } from "./shared"

import { dispatchRequest } from "./shared"

export interface MessagesDispatchResult {
  accountId: string
  response: AsyncIterable<unknown> | Record<string, unknown>
  identity: DispatchIdentity
}

interface DispatchMessagesOptions {
  payload: AnthropicMessagesPayload
  admission: RequestAdmission
  signal?: AbortSignal
  forwardedHeaders?: Record<string, string | undefined>
  c?: Context
}

export async function dispatchMessages(
  options: DispatchMessagesOptions,
): Promise<MessagesDispatchResult> {
  const { payload, admission, signal, forwardedHeaders, c } = options
  const result = await dispatchRequest(
    { routeKind: "messages", payload, forwardedHeaders, c },
    admission,
    signal,
  )
  return {
    accountId: result.identity.ownerId,
    response: result.response,
    identity: result.identity,
  } as MessagesDispatchResult
}
