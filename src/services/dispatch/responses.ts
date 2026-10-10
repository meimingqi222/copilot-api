/**
 * Responses API 调度器：HTTP `/responses` 与 `/responses/compact` 的统一入口。
 *
 * 所有 Provider Connection 都经 `dispatchRequest` 选路与 failover：responses
 * endpoint 走 `adapter.createResponses` 原生调用，其余 endpoint 走跨协议翻译。
 * Responses WebSocket 已选定连接，直接调用 `~/services/copilot/create-responses`。
 */

import type { Context } from "hono"

import type { RequestAdmission } from "~/lib/request-admission"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import type { DispatchIdentity } from "./shared"

import { dispatchRequest } from "./shared"

type ResponsesDispatchResult =
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
