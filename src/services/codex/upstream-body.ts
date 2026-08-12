import type { RequestExecutionContext } from "~/services/providers/runtime"

import { HTTPError } from "~/lib/error"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import {
  type ResponsesPayload,
  withDefaultReasoningSummary,
} from "~/services/copilot/responses-api"

/**
 * Codex outbound body assembly, extracted from create-responses-once.ts so
 * that file stays under the line budget. Mirrors CPA's
 * codex_openai-responses_request.go normalization.
 */

export function isResponsesLiteRequest(
  payload: ResponsesPayload,
  ctx?: RequestExecutionContext,
): boolean {
  // 1. Forwarded HTTP header from the codex client.
  const headerValue =
    ctx?.forwardedHeaders?.["x-openai-internal-codex-responses-lite"]
  if (isResponsesLiteMarker(headerValue)) {
    return true
  }

  // 2. WebSocket transport marker carried inside client_metadata.
  const clientMetadata = (payload as { client_metadata?: unknown })
    .client_metadata
  if (clientMetadata && typeof clientMetadata === "object") {
    const marker = (clientMetadata as Record<string, unknown>)[
      "ws_request_header_x_openai_internal_codex_responses_lite"
    ]
    if (isResponsesLiteMarker(marker)) {
      return true
    }
  }

  return false
}

function isResponsesLiteMarker(value: unknown): boolean {
  return (
    value === true
    || (typeof value === "string" && value.trim().toLowerCase() === "true")
  )
}

/**
 * Resolve the `parallel_tool_calls` value to send upstream, mirroring CPA's
 * normalizeCodexParallelToolCalls:
 *   - Responses Lite requests must send false (upstream rejects true together
 *     with the Lite marker).
 *   - Non-Lite requests keep the client's explicit value when tools are
 *     present; when no tools are present the field is dropped entirely
 *     (CPA deletes it — it is meaningless without tools).
 *   - Default (client omitted the field): true.
 */
function resolveCodexParallelToolCalls(
  payload: ResponsesPayload,
  responsesLite: boolean,
): boolean | undefined {
  if (responsesLite) return false
  const tools = (payload as { tools?: unknown }).tools
  const hasTools = Array.isArray(tools) && tools.length > 0
  if (!hasTools) return undefined
  if (typeof payload.parallel_tool_calls === "boolean") {
    return payload.parallel_tool_calls
  }
  return true
}

/**
 * Codex upstream does not accept the "system" role in input items (CPA
 * convertSystemRoleToDeveloper: "Codex API does not accept 'system' role in
 * the input array"). Rewrite role "system" → "developer" without mutating the
 * caller's payload; returns the original array when nothing needs changing.
 */
export function convertSystemRoleToDeveloper(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input
  }
  // Mutable state object so the linter's control-flow analysis keeps
  // `changed` a plain boolean (it is only flipped inside the map callback).
  const state = { changed: false }
  const items = (input as Array<unknown>).map((item) => {
    if (
      item !== null
      && typeof item === "object"
      && !Array.isArray(item)
      && (item as { role?: unknown }).role === "system"
    ) {
      state.changed = true
      return { ...(item as Record<string, unknown>), role: "developer" }
    }
    return item
  })
  return state.changed ? items : input
}

/**
 * Builds the body sent to the Codex upstream /responses endpoint.
 *
 * Codex /responses rejects many standard Responses API parameters with
 * "Unsupported parameter: <name>". Strip them out before forwarding.
 * See CLIProxyAPI codex_openai-responses_request.go for the reference set.
 * Preserve the client's `include` items and append reasoning.encrypted_content
 * (needed for cross-turn replay under store=false) instead of overwriting -
 * overwriting drops include items the client needs (e.g. reasoning summary
 * controls), which can suppress visible thinking output. Matches oh-my-pi
 * `applyResponsesCompatPolicy` (openai-shared.ts:3192-3195).
 */
export function buildCodexUpstreamBody(
  payload: ResponsesPayload,
  model: string,
  responsesLite: boolean,
): Record<string, unknown> {
  const rawInclude = (payload as { include?: unknown }).include
  const clientInclude: Array<string> =
    Array.isArray(rawInclude) ? (rawInclude as Array<string>) : []
  const parallelToolCalls = resolveCodexParallelToolCalls(
    payload,
    responsesLite,
  )
  // CPA preserves stream_options.reasoning_summary_delivery and (on the WS
  // transport) include_usage; everything else is dropped. include_usage is
  // what makes the upstream include `usage` in response.completed — without
  // it, usage_stats/performance monitoring records nothing for the turn.
  // The HTTP path strips include_usage again in finalizeCodexOutboundBody
  // (the codex HTTP backend rejects it; CPA drops it there too).
  const streamOptions = (
    payload as unknown as {
      stream_options?: {
        reasoning_summary_delivery?: unknown
        include_usage?: unknown
      }
    }
  ).stream_options
  const reasoningSummaryDelivery = streamOptions?.reasoning_summary_delivery
  const includeUsage = streamOptions?.include_usage
  // CPA keeps only service_tier "priority" and strips every other value.
  const serviceTier = (payload as unknown as { service_tier?: unknown })
    .service_tier
  const keptStreamOptions: Record<string, unknown> = {}
  if (reasoningSummaryDelivery !== undefined) {
    keptStreamOptions.reasoning_summary_delivery = reasoningSummaryDelivery
  }
  if (includeUsage !== undefined) {
    keptStreamOptions.include_usage = includeUsage
  }
  return {
    ...payload,
    model,
    stream: true,
    store: false,
    parallel_tool_calls: parallelToolCalls,
    include:
      clientInclude.includes("reasoning.encrypted_content") ? clientInclude : (
        [...clientInclude, "reasoning.encrypted_content"]
      ),
    ...withDefaultReasoningSummary(payload.reasoning),
    instructions:
      typeof payload.instructions === "string" ? payload.instructions : "",
    // `input`-level normalization (system→developer) happens once, last, in
    // `finalizeCodexOutboundBody` — every send site applies it there instead
    // of here so it can never be bypassed by a path that rebuilds `input`.
    input: payload.input,
    previous_response_id: undefined,
    prompt_cache_retention: undefined,
    safety_identifier: undefined,
    stream_options:
      Object.keys(keptStreamOptions).length === 0 ?
        undefined
      : keptStreamOptions,
    max_output_tokens: undefined,
    max_completion_tokens: undefined,
    temperature: undefined,
    top_p: undefined,
    truncation: undefined,
    user: undefined,
    context_management: undefined,
    service_tier: serviceTier === "priority" ? "priority" : undefined,
  }
}

/**
 * Remove all `reasoning` items from a Responses `input` array.
 *
 * The OpenAI Responses API accepts reasoning items in only two valid shapes:
 * fully paired (each reasoning item immediately followed by the item it
 * reasoned about) or omitted entirely. A partially-stripped input triggers a
 * 400 ("reasoning ... provided without its required following item"), so we
 * drop *every* reasoning item and keep messages / function_call /
 * custom_tool_call and their outputs intact.
 *
 * Used for self-contained replays (fresh WS socket / HTTP fallback) where the
 * accumulated transcript's historical `reasoning.encrypted_content` blobs are
 * both the bulk of the payload (blowing past the WS frame the upstream can
 * process) and stale relative to the freshly dialed upstream context. Dropping
 * them shrinks the replay and avoids stale-signature rejections; the only cost
 * is losing cross-turn chain-of-thought continuity on the (rare) recovery path.
 */
export function stripReasoningItems(input: Array<unknown>): Array<unknown> {
  return input.filter(
    (item) =>
      item === null
      || typeof item !== "object"
      || (item as { type?: unknown }).type !== "reasoning",
  )
}

/**
 * Reject a chained Codex /responses request that would otherwise travel over
 * plain HTTP. `previous_response_id` is WebSocket-only (CPA): a fresh HTTP
 * request has no server-side conversation chain to reference, so forwarding
 * the incremental delta would yield a useless `function_call_output` with no
 * matching `function_call` upstream. Clients (Crush's Responses chaining)
 * detect the `previous_response_not_found` marker and retry with a full
 * self-contained replay instead.
 */
export function chainedHttpCodexRequestError(): HTTPError {
  const errorBody = JSON.stringify({
    error: {
      type: "invalid_request_error",
      code: "previous_response_not_found",
      message:
        "Chained Codex requests require WebSocket transport or full replay.",
    },
  })
  return new HTTPError(
    "previous_response_not_found: chained Codex request requires full replay",
    new Response(errorBody, { status: 409 }),
    errorBody,
  )
}

export function assertChainedHttpReplayAvailable(
  previousResponseId: string | undefined,
  useUpstreamWs: boolean,
  httpFallbackBody: Record<string, unknown> | undefined,
  memoryTraceId: string | undefined,
): void {
  if (previousResponseId && !useUpstreamWs && !httpFallbackBody) {
    // Telemetry for how often the 409 recovery-required path actually fires
    // in real traffic (no client-supplied stable session id, or the
    // transcript for one was evicted/never written) — see P2 goal of making
    // cap-tuning (ws-transcript-cache.ts MAX_TRANSCRIPT_* ) answerable from
    // telemetry instead of guesswork.
    updateMemoryTrace(memoryTraceId, "transcript_replay_unavailable", {
      provider: "codex",
    })
    throw chainedHttpCodexRequestError()
  }
}
