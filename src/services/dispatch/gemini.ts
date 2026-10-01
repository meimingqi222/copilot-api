/**
 * Gemini generateContent 调度器。
 *
 * 与 chat/messages/responses 一致：普通 Provider Connection 路径统一走
 * `dispatchRequest` → `adapter.createGeminiGenerateContent`。Gemini 客户端
 * 目前只路由到 gemini endpoint（不做跨协议 fallback）。
 */

import type { Context } from "hono"

import type { RequestAdmission } from "~/lib/request-admission"
import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
  GeminiStreamEvent,
} from "~/services/protocols/gemini"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import type { DispatchIdentity } from "./shared"

import { dispatchRequest } from "./shared"

type GeminiDispatchResult =
  | {
      accountId: string
      response: AsyncIterable<GeminiStreamEvent>
      identity: DispatchIdentity
    }
  | {
      accountId: string
      response: GeminiGenerateContentResponse
      identity: DispatchIdentity
    }

export async function dispatchGemini(
  payload: GeminiGenerateContentRequest & { model: string },
  admission: RequestAdmission,
  signal?: AbortSignal,
  c?: Context,
  executionContext?: RequestExecutionContext,
): Promise<GeminiDispatchResult> {
  const result = await dispatchRequest(
    { routeKind: "gemini", payload, c, executionContext },
    admission,
    signal,
  )
  return {
    accountId: result.identity.ownerId,
    response: result.response,
    identity: result.identity,
  } as GeminiDispatchResult
}
