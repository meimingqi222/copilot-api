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

import { dispatchRequest } from "./shared"

export type ResponsesDispatchResult =
  | { accountId: string; response: AsyncIterable<CopilotStreamEventLike> }
  | { accountId: string; response: ResponsesResponse }

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
    accountId: result.credentialId,
    response: result.response,
  } as ResponsesDispatchResult
}
