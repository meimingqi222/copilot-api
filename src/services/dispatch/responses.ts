/**
 * Responses API 调度器(unified path for provider connections)。
 *
 * Account-backed 路径仍走 `~/services/copilot/create-responses` +
 * `delegateResponsesToNativeAdapter`;普通 Provider Connection 路径走本模块,
 * 通过 `dispatchRequest` 统一调度到 `adapter.createResponses`。
 */

import type { Context } from "hono"

import type { RequestAdmission } from "~/lib/request-admission"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import type { DispatchIdentity } from "./shared"

import { dispatchRequest } from "./shared"

export type ResponsesDispatchResult =
  | {
      accountId: string
      response: AsyncIterable<CopilotStreamEventLike>
      identity: DispatchIdentity
    }
  | {
      accountId: string
      response: ResponsesResponse
      identity: DispatchIdentity
    }

export async function dispatchResponses(
  payload: ResponsesPayload,
  admission: RequestAdmission,
  signal?: AbortSignal,
  c?: Context,
  executionContext?: RequestExecutionContext,
): Promise<ResponsesDispatchResult> {
  const result = await dispatchRequest(
    { routeKind: "responses", payload, c, executionContext },
    admission,
    signal,
  )
  return {
    accountId: result.identity.ownerId,
    response: result.response,
    identity: result.identity,
  } as ResponsesDispatchResult
}
