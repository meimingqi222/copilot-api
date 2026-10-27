/**
 * 单 wire 原生适配器工厂。
 *
 * Claude / Kimi / Antigravity / Codebuff / Windsurf 的适配器只做一件事：
 * 把 `create*Once` 的结果包成 `{ credentialId, response }`。这里把这段骨架
 * 收成一份，适配器文件只声明 protocol 与各自的 once 实现。
 */
import type {
  ApiCredential,
  ProviderConnection,
  ProviderProtocol,
  RouteTarget,
} from "~/lib/provider-connections"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import type {
  AdapterChatResult,
  AdapterMessagesResult,
  AdapterResponsesResult,
  ProtocolAdapter,
} from "./types"

type OnceTarget = {
  connection: ProviderConnection
  credential: ApiCredential
}

type OnceCall<TPayload, TResult> = (
  target: OnceTarget,
  payload: TPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
) => Promise<TResult>

export function createOnceAdapter(input: {
  protocol: ProviderProtocol
  chat?: OnceCall<
    ChatCompletionsPayload,
    AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse
  >
  messages?: OnceCall<
    AnthropicMessagesPayload,
    AsyncIterable<unknown> | Record<string, unknown>
  >
  responses?: OnceCall<
    ResponsesPayload,
    AsyncIterable<CopilotStreamEventLike> | ResponsesResponse
  >
  resolveDispatchModel?: (target: RouteTarget) => string
}): ProtocolAdapter {
  const adapter: ProtocolAdapter = { protocol: input.protocol }

  if (input.resolveDispatchModel) {
    adapter.resolveDispatchModel = input.resolveDispatchModel
  }

  if (input.chat) {
    const chat = input.chat
    adapter.createChatCompletions = async (params) => {
      const response = await chat(
        { connection: params.connection, credential: params.credential },
        params.payload,
        params.signal,
        params.ctx,
      )
      return {
        credentialId: params.credential.id,
        response,
      } as AdapterChatResult
    }
  }

  if (input.messages) {
    const messages = input.messages
    adapter.createMessages = async (params) => {
      const response = await messages(
        { connection: params.connection, credential: params.credential },
        params.payload,
        params.signal,
        params.ctx,
      )
      return {
        credentialId: params.credential.id,
        response,
      } as AdapterMessagesResult
    }
  }

  if (input.responses) {
    const responses = input.responses
    adapter.createResponses = async (params) => {
      const response = await responses(
        { connection: params.connection, credential: params.credential },
        params.payload,
        params.signal,
        params.ctx,
      )
      return {
        credentialId: params.credential.id,
        response,
      } as AdapterResponsesResult
    }
  }

  return adapter
}
