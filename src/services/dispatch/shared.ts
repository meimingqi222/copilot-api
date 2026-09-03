/**
 * Shared dispatch logic for chat-completions, messages, and responses routes.
 */

import type { RouteTarget } from "~/lib/provider-connections"
import type { RequestAdmission } from "~/lib/request-admission"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/responses-api"
import type {
  AdapterChatResult,
  AdapterMessagesResult,
  AdapterResponsesResult,
  AnthropicMessagesPayload,
} from "~/services/protocols"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { HTTPError } from "~/lib/error"
import {
  getSensitiveWordMatcherFromEnv,
  obfuscateOpenAiMessages,
  obfuscateResponsesPayload,
} from "~/lib/sensitive-words"
import { createChatViaMessages } from "~/services/protocols/chat-via-messages"
import { createChatViaResponses } from "~/services/protocols/chat-via-responses"
import { createMessagesViaChat } from "~/services/protocols/messages-via-chat"
import { createResponsesViaChat } from "~/services/protocols/responses-via-chat"

import { executeWithFailover } from "./failover"

export interface ChatDispatchOptions {
  routeKind: "chat"
  payload: ChatCompletionsPayload
  c?: import("hono").Context
  executionContext?: RequestExecutionContext
}

export interface MessagesDispatchOptions {
  routeKind: "messages"
  payload: AnthropicMessagesPayload
  forwardedHeaders?: Record<string, string | undefined>
  c?: import("hono").Context
}

export interface ResponsesDispatchOptions {
  routeKind: "responses"
  payload: ResponsesPayload
  c?: import("hono").Context
  executionContext?: RequestExecutionContext
}

export type DispatchOptions =
  | ChatDispatchOptions
  | MessagesDispatchOptions
  | ResponsesDispatchOptions

export interface DispatchIdentity {
  ownerId: string
  connectionId: string
  credentialId: string
  provider: string
}

export type DispatchResult =
  | (AdapterChatResult & { identity: DispatchIdentity })
  | (AdapterMessagesResult & { identity: DispatchIdentity })
  | (AdapterResponsesResult & { identity: DispatchIdentity })

function decorateResult(
  result: AdapterChatResult | AdapterMessagesResult | AdapterResponsesResult,
  current: RequestAdmission,
): DispatchResult {
  const identity: DispatchIdentity = {
    ownerId: current.account?.id ?? current.connection.id,
    connectionId: current.target.connectionId,
    credentialId: current.target.credentialId,
    provider: current.account?.provider ?? current.target.protocol,
  }
  return { ...result, identity } as DispatchResult
}

export async function dispatchRequest(
  options: DispatchOptions,
  admission: RequestAdmission,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  // 统一敏感词混淆：在进入 provider 适配器之前处理所有 payload 格式。
  // chat/messages 用 obfuscateOpenAiMessages，responses 用 obfuscateResponsesPayload。
  // Antigravity 走 chat 路由，翻译成 Gemini 格式前已在此处混淆 messages。
  // 按 routeKind 分支收窄 payload 类型，避免联合类型泄漏进 execute 闭包。
  const sensitiveMatcher = getSensitiveWordMatcherFromEnv()

  if (options.routeKind === "chat") {
    const payload = applySensitiveWords(
      options.payload,
      "chat",
      sensitiveMatcher,
    )
    return executeWithFailover({
      payload,
      admission,
      signal,
      routeKind: "chat",
      logPrefix: "[dispatch/chat]",
      c: options.c,
      execute: (adapter, target: RouteTarget, current) => {
        // Step B 后 admission 始终携带 connection/credential;
        // account-backed 路径下由 accountToConnection 构造虚拟对象。
        const { connection: conn, credential: cred } = current

        const executionContext = {
          initiator: current.initiator,
          c: options.c,
          ...options.executionContext,
        }
        const chatPayload = {
          ...payload,
          model: target.upstreamModelId,
        }

        // Follow the endpoint selected by route-target resolution. Adapter
        // method availability alone must not bypass a protocol fallback.
        if (target.endpoint === "chat" && adapter?.createChatCompletions) {
          return adapter
            .createChatCompletions({
              target,
              connection: conn,
              credential: cred,
              payload: chatPayload,
              signal,
              ctx: executionContext,
            })
            .then((r) => decorateResult(r, current))
        }

        if (target.endpoint === "messages") {
          const createMessages = adapter?.createMessages?.bind(adapter)
          if (createMessages) {
            return createChatViaMessages({
              target,
              connection: conn,
              credential: cred,
              payload: chatPayload,
              signal,
              ctx: executionContext,
              messagesExecutor: (p) => createMessages(p),
            }).then((r) => decorateResult(r, current))
          }
        }

        if (target.endpoint === "responses") {
          const createResponses = adapter?.createResponses?.bind(adapter)
          if (createResponses) {
            return createChatViaResponses({
              target,
              connection: conn,
              credential: cred,
              payload: chatPayload,
              signal,
              ctx: executionContext,
              responsesExecutor: (p) => createResponses(p),
            }).then((r) => decorateResult(r, current))
          }
        }

        throw new HTTPError(
          `Protocol "${target.protocol}" does not support chat completions via ${target.endpoint}`,
          new Response("Not Implemented", { status: 501 }),
        )
      },
    })
  }

  if (options.routeKind === "responses") {
    const payload = applySensitiveWords(
      options.payload,
      "responses",
      sensitiveMatcher,
    )
    return executeWithFailover({
      payload,
      admission,
      signal,
      routeKind: "responses",
      logPrefix: "[dispatch/responses]",
      c: options.c,
      execute: (adapter, target: RouteTarget, current) => {
        const { connection: conn, credential: cred } = current

        const executionContext = {
          initiator: current.initiator,
          c: options.c,
          ...options.executionContext,
        }
        if (adapter?.createResponses && target.endpoint === "responses") {
          return adapter
            .createResponses({
              target,
              connection: conn,
              credential: cred,
              payload: {
                ...payload,
                model: target.upstreamModelId,
              },
              signal,
              ctx: executionContext,
            })
            .then((r) => decorateResult(r, current))
        }
        const createChat = adapter?.createChatCompletions?.bind(adapter)
        if (target.endpoint === "chat" && createChat) {
          return createResponsesViaChat({
            target,
            connection: conn,
            credential: cred,
            payload: {
              ...payload,
              model: target.upstreamModelId,
            },
            signal,
            ctx: executionContext,
            chatExecutor: (p) => createChat(p),
          }).then((r) => decorateResult(r, current))
        }
        throw new HTTPError(
          `Protocol "${target.protocol}" does not support /responses`,
          new Response("Not Implemented", { status: 501 }),
        )
      },
    })
  }

  const payload = applySensitiveWords(
    options.payload,
    "messages",
    sensitiveMatcher,
  )
  return executeWithFailover({
    payload,
    admission,
    signal,
    routeKind: "messages",
    logPrefix: "[dispatch/messages]",
    c: options.c,
    execute: (adapter, target: RouteTarget, current) => {
      const { connection: conn, credential: cred } = current

      const messageExecutionContext = {
        initiator: current.initiator,
        forwardedHeaders: options.forwardedHeaders,
      }

      // Follow the endpoint selected by route-target resolution. Native
      // Messages passthrough is valid only for a messages endpoint target.
      if (target.endpoint === "messages" && adapter?.createMessages) {
        return adapter
          .createMessages({
            target,
            connection: conn,
            credential: cred,
            payload: {
              ...payload,
              model: target.upstreamModelId,
            },
            signal,
            ctx: messageExecutionContext,
          })
          .then((r) => decorateResult(r, current))
      }

      // Cross-protocol fallback: translate Anthropic Messages -> Chat
      // Completions, delegate to createChatCompletions, then translate the
      // response back. Enables /v1/messages to reach chat-only targets.
      const createChat = adapter?.createChatCompletions?.bind(adapter)
      if (target.endpoint === "chat" && createChat) {
        return createMessagesViaChat({
          target,
          connection: conn,
          credential: cred,
          payload: {
            ...payload,
            model: target.upstreamModelId,
          },
          signal,
          ctx: messageExecutionContext,
          chatExecutor: (p) => createChat(p),
        }).then((r) => decorateResult(r, current))
      }

      throw new HTTPError(
        `Protocol "${target.protocol}" does not support /messages via ${target.endpoint}`,
        new Response("Not Implemented", { status: 501 }),
      )
    },
  })
}

/**
 * 对 dispatch 入口的 payload 做敏感词混淆。
 * 泛型 T 保持原始 payload 类型，混淆函数只改文本不改结构。
 */
function applySensitiveWords<T>(
  payload: T,
  routeKind: "chat" | "messages" | "responses",
  matcher: ReturnType<typeof getSensitiveWordMatcherFromEnv>,
): T {
  if (!matcher) return payload
  const record = payload as unknown as Record<string, unknown>
  if (routeKind === "chat" || routeKind === "messages") {
    return obfuscateOpenAiMessages(record, matcher) as unknown as T
  }
  return obfuscateResponsesPayload(record, matcher) as unknown as T
}
