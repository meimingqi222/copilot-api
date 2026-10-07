import { measureLocalWork } from "~/lib/upstream-performance"

/**
 * Pair translator for wire combinations without a hand-written wrapper.
 *
 * The four original cross-endpoint wrappers (`chat-via-messages`,
 * `messages-via-chat`, `chat-via-responses`, `responses-via-chat`) carry
 * per-wire behavior that a generic call would lose (prompt-cache breakpoints,
 * structured stream twins, memory traces, SSE framing). They stay as they are.
 *
 * Adding Gemini would have meant six more near-identical wrappers, so those
 * directions go through one spec table instead: each wire contributes a
 * decode/encode codec, and `createTranslatedCall` is the only place that
 * plans the translation, enforces the capability preflight and dispatches.
 */

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type { RequestExecutionContext } from "~/services/providers/runtime"
import type {
  IRWire,
  RequestIR,
  ResultIR,
  StreamEvent,
} from "~/services/ir/types"

import { HTTPError, LocalPayloadUnsupportedError } from "~/lib/error"
import {
  addRequestTranslationTime,
  measureTranslatedStream,
} from "~/lib/request-performance"
import { planTranslation, recordTranslationLosses } from "~/services/ir"
import {
  needsSearchOrchestration,
  runSearchAwareResult,
  runSearchAwareStream,
} from "~/services/search/orchestrate"
import { listSearchers } from "~/services/search/searcher"
import {
  decodeChatRequest,
  encodeChatRequest,
} from "~/services/ir/codecs/messages-chat/request"
import {
  decodeChatResponse,
  encodeChatResponse,
} from "~/services/ir/codecs/messages-chat/response"
import {
  decodeChatStream,
  decodeMessagesStream,
  encodeChatStream,
  encodeMessagesStream,
} from "~/services/ir/codecs/messages-chat/stream"
import {
  decodeMessagesRequest,
  encodeMessagesRequest,
} from "~/services/ir/codecs/messages-chat/request"
import {
  decodeMessagesResponse,
  encodeMessagesResponse,
} from "~/services/ir/codecs/messages-chat/response"
import {
  decodeGeminiRequest,
  encodeGeminiRequest,
} from "~/services/ir/codecs/gemini/request"
import {
  decodeGeminiResult,
  encodeGeminiResult,
} from "~/services/ir/codecs/gemini/result"
import {
  decodeGeminiStream,
  encodeGeminiStream,
} from "~/services/ir/codecs/gemini/stream"
import { decodeResponsesRequest } from "~/services/ir/codecs/responses/request"
import { encodeResponsesRequest } from "~/services/ir/codecs/responses/request"
import { decodeResponsesResult } from "~/services/ir/codecs/responses/result"
import { encodeResponsesResult } from "~/services/ir/codecs/responses/result"
import {
  decodeResponsesStream,
  encodeResponsesStream,
} from "~/services/ir/codecs/responses/stream"
import { isPlainResult } from "./result-shape"

/** Every codec reads SSE frames off `.data`; the rest of the frame is ignored. */
type SseLike = { data?: string }

interface RequestEncodeContext {
  stream?: boolean
  issuer?: string
  /** Some targets reject historical reasoning in the transcript. */
  preserveHistoricalReasoning?: boolean
}

interface ResultDecodeContext {
  model: string
  request?: RequestIR
}

interface StreamEncodeContext extends ResultDecodeContext {
  estimatedInputTokens: number
}

export interface WireSpec {
  /** `true` when the value is a whole response rather than a stream. */
  isResult(value: unknown): boolean
  decodeRequest(payload: unknown): RequestIR
  encodeRequest(ir: RequestIR, ctx: RequestEncodeContext): unknown
  decodeResult(response: unknown, ctx: ResultDecodeContext): ResultIR
  encodeResult(ir: ResultIR, ctx: ResultDecodeContext): unknown
  decodeStream(
    stream: AsyncIterable<SseLike>,
    ctx: ResultDecodeContext,
  ): AsyncIterable<StreamEvent>
  encodeStream(
    stream: AsyncIterable<StreamEvent>,
    ctx: StreamEncodeContext,
  ): AsyncIterable<unknown>
}

/** Char/4 heuristic over the IR text, wire-agnostic. */
function estimateIrTokens(ir: RequestIR): number {
  let chars = 0
  for (const instruction of ir.instructions)
    for (const part of instruction.parts) chars += part.text.length
  for (const turn of ir.turns)
    for (const part of turn.parts)
      if (part.type === "text") chars += part.text.length
      else if (part.type === "tool_call") chars += part.arguments.length
  return Math.ceil(chars / 4)
}

const chatSpec: WireSpec = {
  isResult: isPlainResult,
  decodeRequest: (payload) =>
    decodeChatRequest(payload as Parameters<typeof decodeChatRequest>[0]),
  encodeRequest: (ir, ctx) =>
    encodeChatRequest(ir, {
      stream: ctx.stream,
      preserveHistoricalReasoning: ctx.preserveHistoricalReasoning,
    }),
  decodeResult: (response) =>
    decodeChatResponse(response as Parameters<typeof decodeChatResponse>[0]),
  encodeResult: (result) => encodeChatResponse(result),
  decodeStream: (stream) =>
    decodeChatStream(stream as Parameters<typeof decodeChatStream>[0]),
  encodeStream: (stream) => encodeChatStream(stream),
}

const messagesSpec: WireSpec = {
  isResult: isPlainResult,
  decodeRequest: (payload) =>
    decodeMessagesRequest(
      payload as Parameters<typeof decodeMessagesRequest>[0],
    ),
  encodeRequest: (ir, ctx) =>
    encodeMessagesRequest(ir, { stream: ctx.stream, issuer: ctx.issuer }),
  decodeResult: (response) =>
    decodeMessagesResponse(
      response as Parameters<typeof decodeMessagesResponse>[0],
    ),
  encodeResult: (result) => encodeMessagesResponse(result),
  decodeStream: (stream) => decodeMessagesStream(stream),
  // The messages route and its sibling wrappers consume SSE frames, not raw
  // Anthropic events.
  encodeStream: async function* (stream, ctx) {
    for await (const event of encodeMessagesStream(
      stream,
      ctx.estimatedInputTokens,
    ))
      yield { data: JSON.stringify(event), event: event.type }
  },
}

const responsesSpec: WireSpec = {
  isResult: isPlainResult,
  decodeRequest: (payload) =>
    decodeResponsesRequest(
      payload as Parameters<typeof decodeResponsesRequest>[0],
    ),
  encodeRequest: (ir, ctx) => ({
    ...encodeResponsesRequest(ir),
    ...(ctx.stream !== undefined && { stream: ctx.stream }),
  }),
  decodeResult: (response) =>
    decodeResponsesResult(
      response as Parameters<typeof decodeResponsesResult>[0],
    ),
  encodeResult: (result, ctx) => encodeResponsesResult(result, ctx.request),
  decodeStream: (stream, ctx) =>
    decodeResponsesStream(
      stream as Parameters<typeof decodeResponsesStream>[0],
      ctx.model,
    ),
  encodeStream: (stream, ctx) => encodeResponsesStream(stream, ctx.request),
}

const geminiSpec: WireSpec = {
  isResult: isPlainResult,
  decodeRequest: (payload) =>
    decodeGeminiRequest(payload as Parameters<typeof decodeGeminiRequest>[0]),
  encodeRequest: (ir, ctx) => encodeGeminiRequest(ir, { stream: ctx.stream }),
  decodeResult: (response) =>
    decodeGeminiResult(response as Parameters<typeof decodeGeminiResult>[0]),
  encodeResult: (result) => encodeGeminiResult(result),
  decodeStream: (stream, ctx) => decodeGeminiStream(stream, ctx.model),
  encodeStream: (stream, ctx) => encodeGeminiStream(stream, ctx.model),
}

const WIRE_SPECS: Readonly<Record<IRWire, WireSpec>> = {
  chat: chatSpec,
  messages: messagesSpec,
  responses: responsesSpec,
  gemini: geminiSpec,
}

export function wireSpec(wire: IRWire): WireSpec {
  return WIRE_SPECS[wire]
}

interface ExecutorParams {
  target: RouteTarget
  connection: ProviderConnection
  credential: ApiCredential
  payload: unknown
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}

export type WireExecutor = (params: ExecutorParams) => Promise<{
  credentialId: string
  response: unknown
}>

/** Observability hooks the cross-endpoint wrappers attach to the pipeline. */
type TranslationPhase =
  | "request_decoded"
  | "request_encoded"
  | "result_decoded"
  | "complete"

interface TranslationPhaseDetails {
  request?: RequestIR
  /** The encoded target request, available from `request_encoded` on. */
  targetPayload?: unknown
}

interface TranslatedCallParams {
  /** Wire the client speaks. */
  source: IRWire
  /** Wire the selected target speaks. */
  target: IRWire
  targetPayload: unknown
  connection: ProviderConnection
  credential: ApiCredential
  routeTarget: RouteTarget
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  executor: WireExecutor
  preserveHistoricalReasoning?: boolean
  /**
   * Who owns prompt-cache breakpoints on the target wire. Forwarded to
   * `planTranslation`; omitted means "the caller decides".
   */
  cacheControlPolicy?: "caller" | "target"
  /**
   * Rewrites the encoded target request before dispatch — used by
   * `chat-via-messages` to inject Anthropic cache breakpoints the Chat schema
   * cannot express.
   */
  transformTargetRequest?: (payload: unknown) => unknown
  /** Adjusts the ctx handed to the executor (e.g. request the stream twin). */
  decorateExecutorContext?: (
    ctx: RequestExecutionContext | undefined,
  ) => RequestExecutionContext | undefined
  /** Observes translation phases (memory diagnostics). */
  onPhase?: (phase: TranslationPhase, details: TranslationPhaseDetails) => void
}

/**
 * Translates `targetPayload` from the client wire into `target`'s wire,
 * delegates to `executor`, then translates the upstream result back.
 *
 * The client-visible stream shape is whatever the source wire's encoder
 * produces, which is exactly what that route's consumer already expects.
 *
 * The six `*-via-*` wrappers are thin delegates over this function; the only
 * per-direction behavior they carry is expressed through the optional hooks
 * above, so there is exactly one place that plans, enforces the capability
 * preflight, and dispatches a translation.
 */
export async function createTranslatedCall(
  params: TranslatedCallParams,
): Promise<{ credentialId: string; response: unknown }> {
  const { source, target, targetPayload, connection, routeTarget } = params
  const translationStarted = performance.now()
  const sourceSpec = WIRE_SPECS[source]
  const targetSpec = WIRE_SPECS[target]
  const requestIR = sourceSpec.decodeRequest(targetPayload)
  if (
    source === "responses"
    && target !== "responses"
    && requestIR.generation?.previousResponseId
  ) {
    // A Chat/Messages/Gemini target cannot resolve a Responses continuation ID.
    // Codex recognizes this code and can retry with the complete transcript.
    const errorBody = JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "previous_response_not_found",
        param: "previous_response_id",
        message:
          "This translated Responses request requires full input replay without previous_response_id.",
      },
    })
    throw new HTTPError(
      "previous_response_not_found: full input replay required",
      new Response(errorBody, { status: 400 }),
      errorBody,
    )
  }
  params.onPhase?.("request_decoded", { request: requestIR })
  const searchers = listSearchers()
  const orchestrate =
    searchers.length > 0 && needsSearchOrchestration(requestIR, target)
  const plan = planTranslation(requestIR, {
    wire: target,
    providerId: connection.protocol,
    model: routeTarget.upstreamModelId,
    issuer: connection.id,
    ...(params.cacheControlPolicy && {
      cacheControlPolicy: params.cacheControlPolicy,
    }),
    ...(orchestrate && { orchestratedWebSearch: true }),
  })
  recordTranslationLosses(params.ctx?.c, plan.losses)
  if (!plan.accepted) {
    throw new LocalPayloadUnsupportedError(
      plan.losses.records
        .filter((record) => record.action === "reject")
        .map((record) => record.reason)
        .join("; ") || `${target} target cannot preserve the request`,
    )
  }
  const stream = requestIRStream(requestIR, targetPayload)
  // copilot-native rejects reasoning in the transcript; every other upstream
  // accepts or ignores it.
  const preserveHistoricalReasoning =
    params.preserveHistoricalReasoning
    ?? connection.protocol !== "copilot-native"
  const executor = (payload: unknown) =>
    params.executor({
      target: routeTarget,
      connection,
      credential: params.credential,
      payload,
      signal: params.signal,
      ctx:
        params.decorateExecutorContext ?
          params.decorateExecutorContext(params.ctx)
        : params.ctx,
    })

  // A chat target cannot carry web search, so the proxy runs the search itself
  // before the client-wire encoder ever sees the result.
  if (orchestrate) {
    addRequestTranslationTime(
      params.ctx?.c,
      performance.now() - translationStarted,
    )
    const searchParams = {
      request: requestIR,
      spec: targetSpec,
      searchers,
      execute: executor,
      signal: params.signal,
      initiator: params.ctx?.initiator,
    }
    if (stream === true) {
      // The credential is known up front (it is the one the engine selected);
      // the first upstream call happens lazily inside the generator.
      return {
        credentialId: routeTarget.credentialId,
        response: sourceSpec.encodeStream(runSearchAwareStream(searchParams), {
          model: routeTarget.upstreamModelId,
          request: requestIR,
          estimatedInputTokens: estimateIrTokens(requestIR),
        }),
      }
    }
    const { credentialId, result: orchestrated } =
      await runSearchAwareResult(searchParams)
    return {
      credentialId,
      response: sourceSpec.encodeResult(orchestrated, {
        model: routeTarget.upstreamModelId,
        request: requestIR,
      }),
    }
  }

  const encoded = targetSpec.encodeRequest(requestIR, {
    stream,
    issuer: connection.id,
    preserveHistoricalReasoning,
  })
  const targetRequest =
    params.transformTargetRequest ?
      params.transformTargetRequest(encoded)
    : encoded
  params.onPhase?.("request_encoded", {
    request: requestIR,
    targetPayload: targetRequest,
  })
  addRequestTranslationTime(
    params.ctx?.c,
    performance.now() - translationStarted,
  )
  const result = await executor(targetRequest)
  if (targetSpec.isResult(result.response)) {
    const decoded = measureLocalWork("responseTranslationMs", () =>
      targetSpec.decodeResult(result.response, {
        model: routeTarget.upstreamModelId,
        request: requestIR,
      }),
    )
    params.onPhase?.("result_decoded", { request: requestIR })
    const response = measureLocalWork("responseTranslationMs", () =>
      sourceSpec.encodeResult(decoded, {
        model: routeTarget.upstreamModelId,
        request: requestIR,
      }),
    )
    params.onPhase?.("complete", { request: requestIR })
    return { credentialId: result.credentialId, response }
  }
  return {
    credentialId: result.credentialId,
    response: measureTranslatedStream(
      result.response as AsyncIterable<SseLike>,
      (upstream) =>
        sourceSpec.encodeStream(
          targetSpec.decodeStream(upstream, {
            model: routeTarget.upstreamModelId,
            request: requestIR,
          }),
          {
            model: routeTarget.upstreamModelId,
            request: requestIR,
            estimatedInputTokens: estimateIrTokens(requestIR),
          },
        ),
      params.ctx?.c,
    ),
  }
}

/**
 * Streaming is a client choice, not an IR field: read it off the source wire's
 * own payload (Gemini encodes it on both the body and the method name).
 */
function requestIRStream(
  _ir: RequestIR,
  sourcePayload: unknown,
): boolean | undefined {
  if (
    sourcePayload
    && typeof sourcePayload === "object"
    && "stream" in sourcePayload
  ) {
    const value = (sourcePayload as { stream?: unknown }).stream
    if (typeof value === "boolean") return value
  }
  return undefined
}
