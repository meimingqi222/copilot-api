import type { RequestExecutionContext } from "~/services/providers/runtime"

import { HTTPError } from "~/lib/error"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import {
  type ResponsesPayload,
  withDefaultReasoningSummary,
} from "~/services/protocols/responses/types"

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

export function resolveCodexServiceTier(
  value: unknown,
): "priority" | "flex" | "ultrafast" | undefined {
  if (value === "fast") return "priority"
  return value === "priority" || value === "flex" || value === "ultrafast" ?
      value
    : undefined
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
    // prompt_cache_options is also rejected upstream (CPA
    // deleteCodexRequestFields); prompt_cache_key itself is supported and
    // kept — it drives server-side session affinity.
    prompt_cache_options: undefined,
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
    service_tier: resolveCodexServiceTier(payload.service_tier),
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
 * Pairs of Responses tool items that the upstream requires to be complete.
 *
 * The Codex backend validates input as a whole and rejects *either* half of a
 * pair on its own:
 *   - call without output → 400 "No tool output found for custom tool call ..."
 *   - output without call   → 400 "No tool call found for custom tool call
 *     output with call_id ..."
 *
 * A self-contained replay rebuilt from the transcript cache can contain the
 * former: the model emitted a tool call, the turn was interrupted (or the
 * client dropped the output), and the accumulated transcript kept the call.
 * Since the transcript is what we replay, we must prune the half we own rather
 * than let the upstream reject the whole turn.
 */
/** Output type → its call type, for pairing tool calls with their outputs. */
const TOOL_OUTPUT_CALL_TYPES: Record<string, string> = {
  function_call_output: "function_call",
  custom_tool_call_output: "custom_tool_call",
}

function toolItemType(item: unknown): string | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return undefined
  }
  const type = (item as { type?: unknown }).type
  return typeof type === "string" ? type : undefined
}

function toolItemCallId(item: unknown): string | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return undefined
  }
  const callId = (item as { call_id?: unknown }).call_id
  return typeof callId === "string" && callId.trim() ? callId.trim() : undefined
}

/**
 * Drop tool calls that have no matching output in `input`.
 *
 * Used on self-contained replay payloads, which are assembled by us and are
 * therefore the only side whose half-pairs we can safely remove. Caller-
 * supplied deltas are left untouched — the client owns their semantics.
 *
 * Only well-formed items participate: an entry without a `call_id` cannot be
 * matched either way and is always kept, so this can never silently drop an
 * item it does not understand. Outputs are never pruned (dropping one while
 * its call remains is the *other* upstream 400, and the output is the side
 * the client is waiting on).
 */
export function pruneUnansweredToolCalls(
  input: Array<unknown>,
): Array<unknown> {
  const answered = answeredToolCallKeys(input)
  const result = input.filter((entry) => !isUnansweredToolCall(entry, answered))
  return result.length === input.length ? input : result
}

/** Count the tool calls in `input` that have no matching output. */
export function countUnansweredToolCalls(input: Array<unknown>): number {
  const answered = answeredToolCallKeys(input)
  let count = 0
  for (const entry of input) {
    if (isUnansweredToolCall(entry, answered)) count += 1
  }
  return count
}

/** Keys (`<callType>:<call_id>`) of every tool call that has an output. */
function answeredToolCallKeys(input: Array<unknown>): Set<string> {
  const answered = new Set<string>()
  for (const entry of input) {
    const callType = TOOL_OUTPUT_CALL_TYPES[toolItemType(entry) ?? ""]
    const callId = toolItemCallId(entry)
    if (callType && callId) answered.add(`${callType}:${callId}`)
  }
  return answered
}

function isUnansweredToolCall(entry: unknown, answered: Set<string>): boolean {
  const callType = toolItemType(entry)
  if (callType !== "function_call" && callType !== "custom_tool_call") {
    return false
  }
  const callId = toolItemCallId(entry)
  // A call with no `call_id` is unmatchable; keep it rather than guess.
  if (!callId) return false
  return !answered.has(`${callType}:${callId}`)
}

/**
 * Remove `prompt_cache_breakpoint` markers from input items — both item-level
 * and inside `content`/`output` part arrays. Clients that forward Copilot-CLI-
 * style cache breakpoints hit upstream's `"prompt_cache_breakpoint is not
 * supported on this model"` rejection (mirrors CPA
 * stripCodexResponsesCacheBreakpoints).
 */
export function stripPromptCacheBreakpoints(input: unknown): unknown {
  if (!Array.isArray(input)) return input
  let changed = false
  const items = input.map((rawItem) => {
    if (
      rawItem === null
      || typeof rawItem !== "object"
      || Array.isArray(rawItem)
    ) {
      return rawItem
    }
    let item = rawItem as Record<string, unknown>
    for (const arrayPath of ["content", "output"]) {
      const parts = item[arrayPath]
      if (!Array.isArray(parts)) continue
      const filtered = parts.map((part) => {
        if (
          part !== null
          && typeof part === "object"
          && !Array.isArray(part)
          && "prompt_cache_breakpoint" in (part as Record<string, unknown>)
        ) {
          const { prompt_cache_breakpoint: _drop, ...rest } = part as Record<
            string,
            unknown
          >
          return rest
        }
        return part
      })
      if (filtered.some((part, i) => part !== parts[i])) {
        item = { ...item, [arrayPath]: filtered }
        changed = true
      }
    }
    if ("prompt_cache_breakpoint" in item) {
      const { prompt_cache_breakpoint: _drop, ...rest } = item
      item = rest
      changed = true
    }
    return item
  })
  return changed ? items : input
}

/**
 * Rewrite blank-string `arguments` on history function_call items to `"{}"`.
 * Some Responses clients serialize parameter-less calls as an empty string,
 * which the strict Codex Responses upstream rejects with "`arguments` must be
 * valid JSON" (mirrors CPA normalizeEmptyFunctionCallArguments). Only blank
 * strings are rewritten; non-empty strings pass through unchanged so other
 * errors keep their shape.
 */
export function normalizeEmptyFunctionCallArguments(input: unknown): unknown {
  if (!Array.isArray(input)) return input
  let changed = false
  const items = input.map((rawItem) => {
    const item =
      (
        rawItem !== null
        && typeof rawItem === "object"
        && !Array.isArray(rawItem)
      ) ?
        (rawItem as Record<string, unknown>)
      : undefined
    if (
      item?.type === "function_call"
      && typeof item.arguments === "string"
      && item.arguments.trim() === ""
    ) {
      changed = true
      return { ...item, arguments: "{}" }
    }
    return rawItem
  })
  return changed ? items : input
}

/**
 * Input-level normalizations applied at the final outbound boundary
 * (finalizeCodexOutboundBody) so every send site — first turn, replay,
 * translation — gets them in one place.
 */
export function normalizeCodexInputItems(input: unknown): unknown {
  return convertSystemRoleToDeveloper(
    normalizeEmptyFunctionCallArguments(stripPromptCacheBreakpoints(input)),
  )
}

/**
 * Codex upstream rejects legacy/preview built-in tool type spellings. CPA's
 * normalizeCodexBuiltinToolType centralizes the alias table; extend here if
 * Codex adds more.
 */
const CODEX_BUILTIN_TOOL_ALIASES: Record<string, string> = {
  web_search_preview: "web_search",
  web_search_preview_2025_03_11: "web_search",
}

function normalizeBuiltinToolType(toolType: unknown): string | undefined {
  return typeof toolType === "string" ?
      CODEX_BUILTIN_TOOL_ALIASES[toolType]
    : undefined
}

/** Rewrite `type` fields inside an array of tools. */
function normalizeToolArray(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools
  let changed = false
  const next = tools.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return raw
    }
    const item = raw as Record<string, unknown>
    const normalized = normalizeBuiltinToolType(item.type)
    if (!normalized) return raw
    changed = true
    return { ...item, type: normalized }
  })
  return changed ? next : tools
}

/**
 * Normalize built-in tool type spellings across the three locations the
 * upstream checks: `tools[]`, `tool_choice.type`, `tool_choice.tools[]`
 * (mirrors CPA normalizeCodexBuiltinTools).
 */
export function normalizeCodexBuiltinTools(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const tools = normalizeToolArray(body.tools)
  if (tools === body.tools && body.tool_choice === undefined) {
    return body
  }

  const toolChoice = body.tool_choice
  let nextToolChoice = toolChoice
  if (
    toolChoice !== null
    && typeof toolChoice === "object"
    && !Array.isArray(toolChoice)
  ) {
    const tc = { ...(toolChoice as Record<string, unknown>) }
    const normalizedType = normalizeBuiltinToolType(tc.type)
    if (normalizedType) tc.type = normalizedType
    tc.tools = normalizeToolArray(tc.tools)
    nextToolChoice = tc
  }

  const next = { ...body, tools, tool_choice: nextToolChoice }
  return next
}

const CODEX_IMAGE_GEN_TOOL = { type: "image_generation", output_format: "png" }

/** Mirrors CPA isImageGenerationFunctionTool. */
function isImageGenerationTool(tool: unknown): boolean {
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
    return false
  }
  const t = tool as Record<string, unknown>
  switch (t.type) {
    case "image_generation":
      return true
    case "function":
      return t.name === "image_gen.imagegen"
    case "namespace": {
      if (t.name !== "image_gen" || !Array.isArray(t.tools)) return false
      return (t.tools as Array<unknown>).some(
        (nested) =>
          nested !== null
          && typeof nested === "object"
          && (nested as Record<string, unknown>).type === "function"
          && (nested as Record<string, unknown>).name === "imagegen",
      )
    }
    default:
      return false
  }
}

/**
 * Inject the `image_generation` built-in tool so paid-plan accounts can
 * actually call imagegen through /responses (mirrors CPA
 * ensureImageGenerationTool). Skipped for Responses Lite requests, `*-spark`
 * models, and free-plan credentials (upstream rejects the tool there), and
 * when the body already carries an image-generation tool in any of its
 * accepted shapes.
 */
export function ensureImageGenerationTool(
  body: Record<string, unknown>,
  options: { model?: string; responsesLite?: boolean; planType?: string },
): Record<string, unknown> {
  if (options.responsesLite) return body
  if (typeof options.model === "string" && options.model.endsWith("spark")) {
    return body
  }
  if (options.planType?.trim().toLowerCase() === "free") return body

  const tools = body.tools
  if (!Array.isArray(tools)) {
    return { ...body, tools: [CODEX_IMAGE_GEN_TOOL] }
  }
  if (tools.some(isImageGenerationTool)) return body
  return { ...body, tools: [...tools, CODEX_IMAGE_GEN_TOOL] }
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
