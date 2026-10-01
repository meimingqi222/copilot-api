import type {
  ResponsesPayload,
  ResponsesResponse,
  ResponsesUsage,
} from "~/services/protocols/responses/types"
import type {
  IRPart,
  IRStop,
  IRUsage,
  IRWebSearchResult,
  RequestIR,
  ResultIR,
} from "~/services/ir/types"

type WireRecord = Record<string, unknown>

function record(value: unknown): WireRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as WireRecord)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Records inside `value[key]`, when that key holds an array of objects. */
function array(value: unknown, key: string): Array<WireRecord> {
  const holder = record(value)
  const found = holder?.[key]
  if (!Array.isArray(found)) return []
  return found
    .map(record)
    .filter((entry): entry is WireRecord => entry !== undefined)
}

function decodeResponsesUsage(
  usage: ResponsesUsage | undefined,
): IRUsage | undefined {
  if (!usage) return undefined
  return {
    source: "reported",
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cacheReadTokens: usage.input_tokens_details?.cached_tokens,
    cacheWriteTokens: usage.input_tokens_details?.cache_creation_input_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  }
}

function encodeResponsesUsage(
  usage: IRUsage | undefined,
): ResponsesUsage | undefined {
  if (!usage) return undefined
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens:
      usage.totalTokens
      ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined ?
        usage.inputTokens + usage.outputTokens
      : undefined),
    ...((
      usage.cacheReadTokens !== undefined
      || usage.cacheWriteTokens !== undefined
    ) ?
      {
        input_tokens_details: {
          ...(usage.cacheReadTokens !== undefined ?
            { cached_tokens: usage.cacheReadTokens }
          : {}),
          ...(usage.cacheWriteTokens !== undefined ?
            { cache_creation_input_tokens: usage.cacheWriteTokens }
          : {}),
        },
      }
    : {}),
    ...(usage.reasoningTokens !== undefined ?
      { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
    : {}),
  }
}

function decodeStop(response: ResponsesResponse): IRStop {
  if (response.status === "failed")
    return { reason: "error", raw: response.error?.type }
  if (response.incomplete_details?.reason === "max_output_tokens")
    return { reason: "max_tokens", raw: "max_output_tokens" }
  if (response.status === "incomplete")
    return { reason: "incomplete", raw: response.incomplete_details?.reason }
  if (response.output?.some((item) => item.type === "function_call"))
    return { reason: "tool_calls" }
  return { reason: "complete", raw: response.status }
}

/** Keep the Responses output order, including each separate reasoning item. */
export function decodeResponsesResult(response: ResponsesResponse): ResultIR {
  const source = { wire: "responses" as const, model: response.model }
  const parts: Array<IRPart> = []
  for (const raw of response.output ?? []) {
    const item = record(raw)
    if (!item) continue
    if (item.type === "reasoning") {
      const summary =
        Array.isArray(item.summary) ?
          item.summary
            .map((rawPart) => text(record(rawPart)?.text) ?? "")
            .join("")
        : ""
      parts.push({
        type: "thinking",
        text: summary,
        source,
        ...(text(item.id) ? { id: text(item.id) } : {}),
        ...(text(item.encrypted_content) ?
          { encryptedContent: text(item.encrypted_content) }
        : {}),
      })
    } else if (item.type === "message") {
      if (!Array.isArray(item.content)) continue
      for (const rawPart of item.content) {
        const part = record(rawPart)
        if (
          part
          && (part.type === undefined
            || part.type === "output_text"
            || part.type === "text")
          && typeof part.text === "string"
        ) {
          parts.push({ type: "text", text: part.text })
        }
      }
    } else if (item.type === "function_call") {
      const callId = text(item.call_id) ?? text(item.id)
      const name = text(item.name)
      if (callId && name) {
        const namespace = text(item.namespace)
        parts.push({
          type: "tool_call",
          id: callId,
          name: namespace ? `${namespace}__${name}` : name,
          arguments: text(item.arguments) ?? "{}",
          ...(namespace ? { namespace, originalName: name } : {}),
        })
      }
    } else if (item.type === "web_search_call") {
      // The upstream ran the search itself; the action carries the query and
      // the visited pages (`action.sources`), which is this wire's only slot
      // for search results.
      const id = text(item.id) ?? text(item.call_id)
      if (id) {
        parts.push({
          type: "server_tool_use",
          id,
          name: "web_search",
          input: JSON.stringify(item.action ?? {}),
        })
        const sources = array(item.action, "sources")
        const results: Array<IRWebSearchResult> = []
        for (const source of sources) {
          const url = text(source.url)
          if (!url) continue
          results.push({
            url,
            ...(text(source.title) && { title: text(source.title) }),
          })
        }
        if (results.length > 0)
          parts.push({ type: "web_search_result", toolUseId: id, results })
      }
    }
  }
  return {
    id: response.id,
    model: response.model,
    source,
    parts,
    stop: decodeStop(response),
    usage: decodeResponsesUsage(response.usage),
    status:
      response.status === "incomplete" || response.status === "failed" ?
        response.status
      : "completed",
    createdAt: response.created_at,
  }
}

function responseItem(
  part: IRPart,
  responseId: string,
  index: number,
): WireRecord | undefined {
  if (part.type === "thinking") {
    return {
      type: "reasoning",
      id: part.id ?? `rs_${responseId}_${index}`,
      summary: part.text ? [{ type: "summary_text", text: part.text }] : [],
      // Ciphertext belongs only to the issuer that produced it. A synthesized
      // summary can be shown to a client, but cannot be replayed as that blob.
      ...(part.source.wire === "responses" && part.encryptedContent ?
        { encrypted_content: part.encryptedContent }
      : {}),
    }
  }
  if (part.type === "tool_call") {
    return {
      type: "function_call",
      id: `fc_${responseId}_${index}`,
      call_id: part.id,
      name: part.originalName ?? part.name,
      ...(part.namespace ? { namespace: part.namespace } : {}),
      arguments: part.arguments,
    }
  }
  if (part.type === "server_tool_use") return webSearchCallItem(part, part.id)
  return undefined
}

/**
 * Responses models an upstream search as one `web_search_call` item, so the
 * executed search and the pages it returned collapse into a single item here.
 */
export function webSearchCallItem(
  part: Extract<IRPart, { type: "server_tool_use" }>,
  id: string,
  results?: Array<IRWebSearchResult>,
): WireRecord {
  let action: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(part.input)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      action = parsed as Record<string, unknown>
  } catch {
    /* A malformed action is not worth dropping the whole item for. */
  }
  return {
    type: "web_search_call",
    id,
    status: "completed",
    action:
      results && results.length > 0 ?
        {
          ...action,
          sources: results.map((result) => ({
            type: "url",
            url: result.url,
            ...(result.title && { title: result.title }),
          })),
        }
      : action,
  }
}

/**
 * Folds each `web_search_result` into the `web_search_call` it belongs to and
 * drops the standalone part — Responses has no separate result item.
 */
function mergeSearchResults(parts: Array<IRPart>): Array<IRPart> {
  const byCallId = new Map<string, Array<IRWebSearchResult>>()
  for (const part of parts)
    if (part.type === "web_search_result")
      byCallId.set(part.toolUseId, part.results)
  if (byCallId.size === 0) return parts
  return parts.flatMap((part): Array<IRPart> => {
    if (part.type === "web_search_result") return []
    if (part.type !== "server_tool_use") return [part]
    const results = byCallId.get(part.id)
    if (!results) return [part]
    const item = webSearchCallItem(part, part.id, results)
    return [{ ...part, input: JSON.stringify(item.action) }]
  })
}

/** Restore the namespace after a Chat model called its flattened tool name. */
export function restoreResponsesToolNamespace(
  part: IRPart,
  request?: RequestIR | ResponsesPayload,
): IRPart {
  if (
    part.type !== "tool_call"
    || part.namespace
    || !request
    || !("turns" in request)
  )
    return part
  const tool = request.tools?.find((candidate) => candidate.name === part.name)
  if (!tool?.namespace || !tool.originalName) return part
  return { ...part, namespace: tool.namespace, originalName: tool.originalName }
}

/** Encode a normalized result without inventing encrypted reasoning content. */
export function encodeResponsesResult(
  result: ResultIR,
  request?: RequestIR | ResponsesPayload,
): ResponsesResponse {
  const output: Array<WireRecord> = []
  let messageText: Array<{ type: "output_text"; text: string }> = []
  const flushText = (): void => {
    if (messageText.length === 0) return
    output.push({
      type: "message",
      id: `msg_${result.id}_${output.length}`,
      role: "assistant",
      content: messageText,
    })
    messageText = []
  }
  const orderedParts =
    result.source.wire === "chat" ?
      [
        ...result.parts.filter((part) => part.type === "thinking"),
        ...result.parts.filter((part) => part.type !== "thinking"),
      ]
    : result.parts
  const mergedParts = mergeSearchResults(orderedParts)
  for (const [index, rawPart] of mergedParts.entries()) {
    const part = restoreResponsesToolNamespace(rawPart, request)
    if (part.type === "text") {
      messageText.push({ type: "output_text", text: part.text })
      continue
    }
    flushText()
    const item = responseItem(part, result.id, index)
    if (item) output.push(item)
  }
  flushText()
  const requestGeneration =
    request && "generation" in request ? request.generation : undefined
  const requestWire = request && "input" in request ? request : undefined
  const outputText = result.parts
    .filter(
      (part): part is Extract<IRPart, { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("")
  const status =
    result.status
    ?? ((
      result.stop?.reason === "max_tokens"
      || result.stop?.reason === "incomplete"
    ) ?
      "incomplete"
    : "completed")
  const response: WireRecord = {
    id: result.id,
    object: "response",
    model: result.model,
    created_at: result.createdAt ?? Math.floor(Date.now() / 1000),
    status,
    output,
    output_text: outputText,
    ...(status === "incomplete" ?
      {
        incomplete_details: {
          reason:
            result.stop?.reason === "max_tokens" ?
              "max_output_tokens"
            : (result.stop?.raw ?? "unknown"),
        },
      }
    : {}),
    ...(encodeResponsesUsage(result.usage) ?
      { usage: encodeResponsesUsage(result.usage) }
    : {}),
    ...((
      requestGeneration?.maxOutputTokens !== undefined
      || requestWire?.max_output_tokens !== undefined
    ) ?
      {
        max_output_tokens:
          requestGeneration?.maxOutputTokens ?? requestWire?.max_output_tokens,
      }
    : {}),
    ...((
      requestGeneration?.parallelToolCalls !== undefined
      || requestWire?.parallel_tool_calls !== undefined
    ) ?
      {
        parallel_tool_calls:
          requestGeneration?.parallelToolCalls
          ?? requestWire?.parallel_tool_calls,
      }
    : {}),
    ...((
      requestGeneration?.store !== undefined || requestWire?.store !== undefined
    ) ?
      { store: requestGeneration?.store ?? requestWire?.store }
    : {}),
    ...((
      requestGeneration?.temperature !== undefined
      || requestWire?.temperature !== undefined
    ) ?
      {
        temperature: requestGeneration?.temperature ?? requestWire?.temperature,
      }
    : {}),
    ...((
      requestGeneration?.topP !== undefined || requestWire?.top_p !== undefined
    ) ?
      { top_p: requestGeneration?.topP ?? requestWire?.top_p }
    : {}),
  }
  return response as unknown as ResponsesResponse
}
