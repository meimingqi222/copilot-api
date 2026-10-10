/**
 * Shared dispatch logic for chat-completions, messages, and responses routes.
 */

import type { Context } from "hono"

import type { RouteTarget } from "~/lib/provider-connections"
import type { RequestAdmission } from "~/lib/request-admission"
import type { IRWire } from "~/services/ir/types"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { ResponsesPayload } from "~/services/protocols/responses/types"
import type {
  AdapterChatResult,
  AdapterGeminiResult,
  AdapterMessagesResult,
  AdapterResponsesResult,
  AnthropicMessagesPayload,
} from "~/services/protocols"
import type { GeminiGenerateContentRequest } from "~/services/protocols/gemini"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import { runRedactedCall } from "~/lib/redaction/context"
import { connectionProvider } from "~/lib/provider-connections"
import {
  clearUsagePricingRounds,
  createUsagePricingRecorder,
} from "~/lib/usage-pricing-rounds"
import {
  observeUpstreamResponseModel,
  observeUpstreamResponseModelFromSseData,
} from "~/lib/request-log"
import {
  getSensitiveWordMatcherFromEnv,
  obfuscateOpenAiMessages,
  obfuscateResponsesPayload,
} from "~/lib/sensitive-words"
import { isAsyncIterable } from "~/services/dispatch/concurrency"
import { createChatViaMessages } from "~/services/protocols/chat-via-messages"
import { createChatViaResponses } from "~/services/protocols/chat-via-responses"
import { createMessagesViaChat } from "~/services/protocols/messages-via-chat"
import { createResponsesViaChat } from "~/services/protocols/responses-via-chat"
import {
  chatRequestsWebSearch,
  decodeChatRequest,
} from "~/services/ir/codecs/messages-chat/request"
import { getProtocolAdapter } from "~/services/protocols/registry"
import {
  createTranslatedCall,
  wireSpec,
  type WireExecutor,
} from "~/services/protocols/wire-pairs"
import {
  runSearchAwareResult,
  runSearchAwareStream,
  type SearchAwareExecutor,
} from "~/services/search/orchestrate"
import { listSearchers } from "~/services/search/searcher"

import { executeWithFailover } from "./failover"

type Adapter = ReturnType<typeof getProtocolAdapter>

/**
 * Binds the adapter method that serves an endpoint, for the table-driven
 * translation path. Returns `undefined` when the endpoint has no wire (or the
 * protocol does not implement it), so the caller reports an unsupported
 * target instead of dispatching into a missing method.
 */
function wireExecutor(
  adapter: Adapter,
  endpoint: RouteTarget["endpoint"],
): { wire: IRWire; executor: WireExecutor } | undefined {
  if (
    endpoint !== "chat"
    && endpoint !== "messages"
    && endpoint !== "responses"
    && endpoint !== "gemini"
  ) {
    return undefined
  }
  const executor =
    endpoint === "chat" ? adapter?.createChatCompletions?.bind(adapter)
    : endpoint === "messages" ? adapter?.createMessages?.bind(adapter)
    : endpoint === "responses" ? adapter?.createResponses?.bind(adapter)
    : adapter?.createGeminiGenerateContent?.bind(adapter)
  // Each adapter method declares its own payload type; the table-driven path
  // erases it and re-encodes into the target wire before calling.
  return executor ?
      { wire: endpoint, executor: executor as unknown as WireExecutor }
    : undefined
}

/**
 * Detours a native chat call through the IR whenever the payload carries a web
 * search intent the chat wire cannot express.
 *
 * Returns `undefined` when nothing needs orchestrating, so the caller keeps
 * its original single call (the common case, with zero added latency).
 */
function chatSearchDetour(params: {
  payload: ChatCompletionsPayload
  target: RouteTarget
  execute: SearchAwareExecutor
  ctx?: RequestExecutionContext
}): Promise<{ credentialId: string; response: unknown }> | undefined {
  clearUsagePricingRounds(params.ctx?.c)
  // The chat wire never carries search itself, so the intent alone decides.
  if (!chatRequestsWebSearch(params.payload)) return undefined
  const searchers = listSearchers()
  if (searchers.length === 0) return undefined
  const request = decodeChatRequest(params.payload)

  const spec = wireSpec("chat")
  const searchParams = {
    request,
    spec,
    searchers,
    execute: params.execute,
    onUsage: createUsagePricingRecorder(
      params.ctx?.c,
      params.target.connectionId,
    ),
  }
  if (params.payload.stream === true) {
    return Promise.resolve({
      credentialId: params.target.credentialId,
      response: spec.encodeStream(runSearchAwareStream(searchParams), {
        model: params.target.upstreamModelId,
        request,
        estimatedInputTokens: 0,
      }),
    })
  }
  return runSearchAwareResult(searchParams).then(
    ({ credentialId, result }) => ({
      credentialId,
      response: spec.encodeResult(result, {
        model: params.target.upstreamModelId,
        request,
      }),
    }),
  )
}

function translatedCall(
  source: IRWire,
  bound: { wire: IRWire; executor: WireExecutor },
  params: {
    target: RouteTarget
    payload: unknown
    connection: RequestAdmission["connection"]
    credential: RequestAdmission["credential"]
    signal?: AbortSignal
    ctx?: RequestExecutionContext
  },
) {
  return createTranslatedCall({
    source,
    target: bound.wire,
    targetPayload: params.payload,
    connection: params.connection,
    credential: params.credential,
    routeTarget: params.target,
    signal: params.signal,
    ctx: params.ctx,
    executor: bound.executor,
  })
}

interface ChatDispatchOptions {
  routeKind: "chat"
  payload: ChatCompletionsPayload
  c?: Context
  executionContext?: RequestExecutionContext
}

interface MessagesDispatchOptions {
  routeKind: "messages"
  payload: AnthropicMessagesPayload
  forwardedHeaders?: Record<string, string | undefined>
  c?: Context
}

interface ResponsesDispatchOptions {
  routeKind: "responses"
  payload: ResponsesPayload
  c?: Context
  executionContext?: RequestExecutionContext
}

interface GeminiDispatchOptions {
  routeKind: "gemini"
  /** `model` is resolved from the URL path by the route, never from the body. */
  payload: GeminiGenerateContentRequest & { model: string }
  c?: Context
  executionContext?: RequestExecutionContext
}

/**
 * Dispatches one candidate for a Gemini client request: native passthrough on a
 * gemini endpoint, otherwise the shared codec table translates to the target's
 * wire. Extracted so `dispatchRequest` stays within its size budget.
 */
function dispatchGeminiTarget(
  options: GeminiDispatchOptions,
  adapter: Adapter,
  target: RouteTarget,
  current: RequestAdmission,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  const { connection: conn, credential: cred } = current
  const executionContext = {
    initiator: current.initiator,
    c: options.c,
    ...options.executionContext,
  }
  const geminiPayload = {
    ...options.payload,
    model: resolveDispatchModel(target),
  }

  if (target.endpoint === "gemini") {
    const createGemini = adapter?.createGeminiGenerateContent?.bind(adapter)
    if (createGemini) {
      return createGemini({
        target,
        connection: conn,
        credential: cred,
        payload: geminiPayload,
        signal,
        ctx: executionContext,
      }).then((r) => decorateResult(r, current, options.c))
    }
  }

  // Cross-protocol fallback: a Gemini client reaching a chat/messages/
  // responses-only target, served by the shared codec table.
  const bound = wireExecutor(adapter, target.endpoint)
  if (bound) {
    return translatedCall("gemini", bound, {
      target,
      payload: geminiPayload,
      connection: conn,
      credential: cred,
      signal,
      ctx: executionContext,
    }).then((r) => decorateResult(r, current, options.c))
  }

  throw new LocalPayloadUnsupportedError(
    `Protocol "${target.protocol}" does not support the Gemini generateContent endpoint via ${target.endpoint}`,
  )
}

type DispatchOptions =
  | ChatDispatchOptions
  | MessagesDispatchOptions
  | ResponsesDispatchOptions
  | GeminiDispatchOptions

export interface DispatchIdentity {
  ownerId: string
  connectionId: string
  credentialId: string
  provider: string
}

type DispatchResult =
  | (AdapterChatResult & { identity: DispatchIdentity })
  | (AdapterMessagesResult & { identity: DispatchIdentity })
  | (AdapterResponsesResult & { identity: DispatchIdentity })
  | (AdapterGeminiResult & { identity: DispatchIdentity })

function decorateResult(
  result: { credentialId: string; response: unknown },
  current: RequestAdmission,
  c?: Context,
): DispatchResult {
  const identity: DispatchIdentity = {
    ownerId: current.connection.id,
    connectionId: current.target.connectionId,
    credentialId: current.target.credentialId,
    provider: connectionProvider(current.connection),
  }
  const decorated = { ...result, identity } as DispatchResult
  return c ? withUpstreamModelAudit(c, decorated) : decorated
}

/**
 * 旁路观测上游响应自报的模型名（审计用，绝不改变转发语义）。
 *
 * 挂在 dispatch 的唯一收敛点 `decorateResult` 上，所以 chat / messages /
 * responses 三条路由以及它们的所有跨协议翻译路径都被覆盖。流式结果包一层
 * 透传生成器，逐事件观测；非流式直接读响应对象。
 *
 * 观测发生在翻译层**之后**：翻译层保留上游的 `model` 字段，所以这里读到的
 * 仍是上游自报的名字（`message.model` / `response.model` / `model`）。
 */
function withUpstreamModelAudit<T extends { response: unknown }>(
  c: Context,
  result: T,
): T {
  const response = result.response
  if (isAsyncIterable<{ data?: string; event?: string }>(response)) {
    return {
      ...result,
      response: observeUpstreamModelStream(c, response),
    }
  }
  observeUpstreamResponseModel(c, response)
  return result
}

async function* observeUpstreamModelStream(
  c: Context,
  stream: AsyncIterable<{ data?: string; event?: string }>,
): AsyncIterable<{ data?: string; event?: string }> {
  for await (const event of stream) {
    observeUpstreamResponseModelFromSseData(c, event?.data, event?.event)
    yield event
  }
}

/**
 * Dispatch-time model id for a route target.
 *
 * Windsurf collapses thinking-effort variants into one head (e.g. `swe-2`)
 * whose `upstreamModelId` is the default-effort SKU (`swe-2-high`). The real
 * SKU must be selected inside the adapter from `reasoning_effort`
 * (`resolveWindsurfRequestModel`). Pre-resolving to `upstreamModelId` here
 * turns a head request into a hidden pin (`swe-2-high`) and silently drops
 * the requested effort (e.g. `medium` → `high`). Pass the requested head id
 * through instead; explicit pins still pin because their
 * `publicModelId === upstreamModelId`.
 */
export function resolveDispatchModel(target: RouteTarget): string {
  if (target.protocol === "windsurf-native") return target.publicModelId
  return target.upstreamModelId
}

export async function dispatchRequest(
  options: DispatchOptions,
  admission: RequestAdmission,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  return runRedactedCall(options.payload, options.c, (payload) =>
    dispatchPreparedRequest(
      { ...options, payload } as DispatchOptions,
      admission,
      signal,
    ),
  )
}

async function dispatchPreparedRequest(
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
        // Step B 后 admission 始终携带 connection/credential。
        const { connection: conn, credential: cred } = current

        const executionContext = {
          initiator: current.initiator,
          c: options.c,
          ...options.executionContext,
        }
        const chatPayload = {
          ...payload,
          model: resolveDispatchModel(target),
        }

        // Follow the endpoint selected by route-target resolution. Adapter
        // method availability alone must not bypass a protocol fallback.
        if (target.endpoint === "chat" && adapter?.createChatCompletions) {
          const createChat = adapter.createChatCompletions.bind(adapter)
          // A chat client can ask for web search (OpenRouter's `plugins`); the
          // chat wire cannot carry it, so the native path detours through the
          // IR loop instead of silently dropping the intent.
          const searchAware = chatSearchDetour({
            payload: chatPayload,
            target,
            ctx: executionContext,
            execute: (payload: unknown) =>
              createChat({
                target,
                connection: conn,
                credential: cred,
                payload: payload as ChatCompletionsPayload,
                signal,
                ctx: executionContext,
              }),
          })
          const call =
            searchAware
            ?? createChat({
              target,
              connection: conn,
              credential: cred,
              payload: chatPayload,
              signal,
              ctx: executionContext,
            })
          return call.then((r) => decorateResult(r, current, options.c))
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
            }).then((r) => decorateResult(r, current, options.c))
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
            }).then((r) => decorateResult(r, current, options.c))
          }
        }

        // Gemini has no dedicated wrapper: the shared codec table carries it.
        if (target.endpoint === "gemini") {
          const bound = wireExecutor(adapter, "gemini")
          if (bound) {
            return translatedCall("chat", bound, {
              target,
              payload: chatPayload,
              connection: conn,
              credential: cred,
              signal,
              ctx: executionContext,
            }).then((r) => decorateResult(r, current, options.c))
          }
        }

        throw new LocalPayloadUnsupportedError(
          `Protocol "${target.protocol}" does not support chat completions via ${target.endpoint}`,
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
                model: resolveDispatchModel(target),
              },
              signal,
              ctx: executionContext,
            })
            .then((r) => decorateResult(r, current, options.c))
        }
        const createChat = adapter?.createChatCompletions?.bind(adapter)
        if (target.endpoint === "chat" && createChat) {
          return createResponsesViaChat({
            target,
            connection: conn,
            credential: cred,
            payload: {
              ...payload,
              model: resolveDispatchModel(target),
            },
            signal,
            ctx: executionContext,
            chatExecutor: (p) => createChat(p),
          }).then((r) => decorateResult(r, current, options.c))
        }
        if (target.endpoint === "messages" || target.endpoint === "gemini") {
          const bound = wireExecutor(adapter, target.endpoint)
          if (bound) {
            return translatedCall("responses", bound, {
              target,
              payload: { ...payload, model: resolveDispatchModel(target) },
              connection: conn,
              credential: cred,
              signal,
              ctx: executionContext,
            }).then((r) => decorateResult(r, current, options.c))
          }
        }
        throw new LocalPayloadUnsupportedError(
          `Protocol "${target.protocol}" does not support /responses`,
        )
      },
    })
  }

  if (options.routeKind === "gemini") {
    // The Gemini wire has its own contents shape; sensitive-word obfuscation
    // is defined for the OpenAI payloads only, so it is a no-op here.
    return executeWithFailover<
      GeminiDispatchOptions["payload"],
      DispatchResult
    >({
      payload: options.payload,
      admission,
      signal,
      routeKind: "gemini",
      logPrefix: "[dispatch/gemini]",
      c: options.c,
      execute: (adapter, target, current) =>
        dispatchGeminiTarget(options, adapter, target, current, signal),
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
        c: options.c,
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
              model: resolveDispatchModel(target),
            },
            signal,
            ctx: messageExecutionContext,
          })
          .then((r) => decorateResult(r, current, options.c))
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
            model: resolveDispatchModel(target),
          },
          signal,
          ctx: messageExecutionContext,
          chatExecutor: (p) => createChat(p),
        }).then((r) => decorateResult(r, current, options.c))
      }

      // Responses (codex/xai and other responses-only targets) and Gemini
      // need no per-wire behavior, so the shared codec table serves them.
      if (target.endpoint === "responses" || target.endpoint === "gemini") {
        const bound = wireExecutor(adapter, target.endpoint)
        if (bound) {
          return translatedCall("messages", bound, {
            target,
            payload: { ...payload, model: resolveDispatchModel(target) },
            connection: conn,
            credential: cred,
            signal,
            ctx: messageExecutionContext,
          }).then((r) => decorateResult(r, current, options.c))
        }
      }

      throw new LocalPayloadUnsupportedError(
        `Protocol "${target.protocol}" does not support /messages via ${target.endpoint}`,
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
  routeKind: "chat" | "messages" | "responses" | "gemini",
  matcher: ReturnType<typeof getSensitiveWordMatcherFromEnv>,
): T {
  if (!matcher) return payload
  const record = payload as unknown as Record<string, unknown>
  if (routeKind === "chat" || routeKind === "messages") {
    return obfuscateOpenAiMessages(record, matcher) as unknown as T
  }
  return obfuscateResponsesPayload(record, matcher) as unknown as T
}
