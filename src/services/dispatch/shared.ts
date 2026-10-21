/**
 * Shared dispatch logic for chat-completions, messages, responses, and gemini routes.
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
import {
  chatRequestsWebSearch,
  decodeChatRequest,
} from "~/services/ir/codecs/messages-chat/request"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"
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
  return executor ?
      { wire: endpoint, executor: executor as unknown as WireExecutor }
    : undefined
}

/**
 * Detours a native chat call through the IR whenever the payload carries a web
 * search intent the chat wire cannot express.
 */
function chatSearchDetour(params: {
  payload: ChatCompletionsPayload
  target: RouteTarget
  execute: SearchAwareExecutor
  ctx?: RequestExecutionContext
}): Promise<{ credentialId: string; response: unknown }> | undefined {
  clearUsagePricingRounds(params.ctx?.c)
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
 * (`resolveWindsurfRequestModel`).
 */
export function resolveDispatchModel(
  target: RouteTarget,
  adapter?: Adapter,
): string {
  if (!adapter) initializeProtocolAdapters()
  const resolvedAdapter = adapter ?? getProtocolAdapter(target.protocol)
  if (resolvedAdapter?.resolveDispatchModel) {
    return resolvedAdapter.resolveDispatchModel(target)
  }
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

function buildExecutionContext(
  options: DispatchOptions,
  current: RequestAdmission,
): RequestExecutionContext {
  if (options.routeKind === "messages") {
    return {
      initiator: current.initiator,
      forwardedHeaders: options.forwardedHeaders,
      c: options.c,
    }
  }
  return {
    initiator: current.initiator,
    c: options.c,
    ...options.executionContext,
  }
}

function unsupportedTargetMessage(source: IRWire, target: RouteTarget): string {
  switch (source) {
    case "chat":
      return `Protocol "${target.protocol}" does not support chat completions via ${target.endpoint}`
    case "responses":
      return `Protocol "${target.protocol}" does not support /responses`
    case "messages":
      return `Protocol "${target.protocol}" does not support /messages via ${target.endpoint}`
    case "gemini":
      return `Protocol "${target.protocol}" does not support the Gemini generateContent endpoint via ${target.endpoint}`
  }
}

function executeCandidateCall(params: {
  source: IRWire
  adapter: Adapter
  target: RouteTarget
  current: RequestAdmission
  payload: { model: string }
  ctx: RequestExecutionContext
  signal?: AbortSignal
}): Promise<{ credentialId: string; response: unknown }> {
  const { source, adapter, target, current, payload, ctx, signal } = params
  const { connection: conn, credential: cred } = current
  const modelPayload = {
    ...payload,
    model: resolveDispatchModel(target, adapter),
  }

  // 1. Native passthrough when source wire matches target endpoint
  if (source === target.endpoint) {
    if (source === "chat" && adapter?.createChatCompletions) {
      const createChat = adapter.createChatCompletions.bind(adapter)
      const chatPayload = modelPayload as ChatCompletionsPayload
      const searchAware = chatSearchDetour({
        payload: chatPayload,
        target,
        ctx,
        execute: (nextPayload: unknown) =>
          createChat({
            target,
            connection: conn,
            credential: cred,
            payload: nextPayload as ChatCompletionsPayload,
            signal,
            ctx,
          }),
      })
      return (
        searchAware
        ?? createChat({
          target,
          connection: conn,
          credential: cred,
          payload: chatPayload,
          signal,
          ctx,
        })
      )
    }
    const native = wireExecutor(adapter, source)
    if (native) {
      return native.executor({
        target,
        connection: conn,
        credential: cred,
        payload: modelPayload,
        signal,
        ctx,
      })
    }
  }

  // 2. Cross-wire IR translation (direction-specific hooks live in wire-pairs.ts)
  const bound = wireExecutor(adapter, target.endpoint)
  if (bound) {
    return translatedCall(source, bound, {
      target,
      payload: modelPayload,
      connection: conn,
      credential: cred,
      signal,
      ctx,
    })
  }

  throw new LocalPayloadUnsupportedError(
    unsupportedTargetMessage(source, target),
  )
}

async function dispatchPreparedRequest(
  options: DispatchOptions,
  admission: RequestAdmission,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  const sensitiveMatcher = getSensitiveWordMatcherFromEnv()
  const payload = applySensitiveWords(
    options.payload,
    options.routeKind,
    sensitiveMatcher,
  )
  return executeWithFailover({
    payload,
    admission,
    signal,
    routeKind: options.routeKind,
    logPrefix: `[dispatch/${options.routeKind}]`,
    c: options.c,
    execute: (adapter, target: RouteTarget, current) =>
      executeCandidateCall({
        source: options.routeKind,
        adapter,
        target,
        current,
        payload,
        ctx: buildExecutionContext(options, current),
        signal,
      }).then((r) => decorateResult(r, current, options.c)),
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
  if (!matcher || routeKind === "gemini") return payload
  const record = payload as unknown as Record<string, unknown>
  if (routeKind === "chat" || routeKind === "messages") {
    return obfuscateOpenAiMessages(record, matcher) as unknown as T
  }
  return obfuscateResponsesPayload(record, matcher) as unknown as T
}
