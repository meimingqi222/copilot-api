/**
 * `*-native` Responses 适配器工厂。
 *
 * Codex 与 xAI 的上游都是 Responses API：适配器只差 protocol 名字与
 * 「发一次请求」的函数，其余（chat→responses 翻译、结果形状）完全相同。
 * 参数化后两边不会再各自漂移。
 */
import type {
  ApiCredential,
  ProviderConnection,
  ProviderProtocol,
} from "~/lib/provider-connections"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { createChatViaResponses } from "./chat-via-responses"
import type { AdapterResponsesResult, ProtocolAdapter } from "./types"

/** 各 provider 的「发一次 Responses 请求」实现。 */
type ResponsesOnce = (
  target: { connection: ProviderConnection; credential: ApiCredential },
  payload: ResponsesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
) => Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse>

export function createResponsesNativeAdapter(
  protocol: ProviderProtocol,
  createResponses: ResponsesOnce,
): ProtocolAdapter {
  return {
    protocol,

    async createChatCompletions({
      target,
      connection,
      credential,
      payload,
      signal,
      ctx,
    }) {
      return createChatViaResponses({
        target,
        connection,
        credential,
        payload,
        signal,
        ctx,
        executor: async ({
          connection: conn,
          payload: responsesPayload,
          signal: sig,
          ctx: context,
        }) => {
          const response = await createResponses(
            { connection: conn, credential },
            responsesPayload,
            sig,
            context,
          )
          return {
            credentialId: credential.id,
            response,
          } as AdapterResponsesResult
        },
      })
    },

    async createResponses({ connection, credential, payload, signal, ctx }) {
      const response = await createResponses(
        { connection, credential },
        payload,
        signal,
        ctx,
      )
      return {
        credentialId: credential.id,
        response,
      } as AdapterResponsesResult
    },
  }
}
