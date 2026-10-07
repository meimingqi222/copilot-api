/**
 * The proxy-side web-search loop.
 *
 * When a client asks for web search but the selected target's wire cannot
 * carry it (i.e. Chat Completions), the proxy runs the search itself instead
 * of rejecting the request: it injects its own `web_search` tool, executes
 * every call the model makes through a search-capable account
 * (see `execute.ts`), feeds the results back and asks again.
 *
 * The loop is wire-agnostic: it drives any target through the `WireSpec` its
 * wire already has (`services/protocols/wire-pairs.ts`), so a new protocol
 * needs no new loop.
 */

import type {
  IRPart,
  IRToolCallPart,
  IRTurn,
  IRUsage,
  RequestIR,
  ResultIR,
  StreamEvent,
} from "~/services/ir/types"
import type { WireSpec } from "~/services/protocols/wire-pairs"
import type { SearchAnswer, Searcher, SearchHit } from "./types"

import { WIRE_CAPABILITIES } from "~/services/ir/capabilities"

import { executeWebSearch } from "./execute"

const MAX_SEARCH_ROUNDS = 6

/** The tool the proxy injects; the client never sees this name. */
const INTERNAL_TOOL_NAME = "web_search"
/** Fallback when the caller already declared a tool with the same name. */
const RESERVED_TOOL_NAME = "__proxy_web_search"

const INTERNAL_TOOL_DESCRIPTION =
  "Search the public web. Call this with the query you want looked up; the "
  + "caller performs the search and returns the results. Use it whenever the "
  + "answer depends on current or external information."

const NO_MORE_SEARCHES =
  "No more searches are available. Answer with what has already been found."

interface SearchAwareExecutorResult {
  credentialId: string
  response: unknown
}

export type SearchAwareExecutor = (
  payload: unknown,
) => Promise<SearchAwareExecutorResult>

interface SearchAwareParams {
  request: RequestIR
  /** Codec bundle of the *target* wire. */
  spec: WireSpec
  searchers: Array<Searcher>
  execute: SearchAwareExecutor
  signal?: AbortSignal
  initiator?: "agent" | "user"
  /** One final usage snapshot per upstream round, for nonlinear pricing. */
  onUsage?: (usage: IRUsage | undefined) => void
}

/** One executed search, in the order it happened. */
interface SearchRecord {
  callId: string
  query: string
  answer?: SearchAnswer
  error?: string
}

/**
 * `true` when the client asked for search and the target wire cannot carry it.
 * Callers combine this with searcher availability before orchestrating.
 */
export function needsSearchOrchestration(
  request: RequestIR,
  targetWire: keyof typeof WIRE_CAPABILITIES,
): boolean {
  if (!request.generation?.webSearch) return false
  return !WIRE_CAPABILITIES[targetWire].webSearch
}

function internalToolName(request: RequestIR): string {
  const taken = new Set((request.tools ?? []).map((tool) => tool.name))
  return taken.has(INTERNAL_TOOL_NAME) ? RESERVED_TOOL_NAME : INTERNAL_TOOL_NAME
}

/**
 * Builds the request the target sees for one round: the native search intent
 * is replaced by our own tool (the proxy is the one searching), and once the
 * round budget is spent the tool is withdrawn so the model must answer.
 */
function roundRequest(
  request: RequestIR,
  internalName: string,
  allowSearch: boolean,
): RequestIR {
  const {
    webSearch: _webSearch,
    webSearchOptions: _options,
    ...generation
  } = request.generation ?? {}
  const tools = (request.tools ?? []).filter(
    (tool) => tool.name !== internalName,
  )
  return {
    ...request,
    ...(Object.keys(generation).length > 0 ?
      { generation: generation as RequestIR["generation"] }
    : { generation: undefined }),
    tools:
      allowSearch ?
        [
          ...tools,
          {
            name: internalName,
            description: INTERNAL_TOOL_DESCRIPTION,
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "The search query." },
              },
              required: ["query"],
            },
          },
        ]
      : tools,
  }
}

function isInternalCall(
  part: IRPart,
  internalName: string,
): part is IRToolCallPart {
  return part.type === "tool_call" && part.name === internalName
}

function queryFor(call: IRToolCallPart): string {
  try {
    const parsed: unknown = JSON.parse(call.arguments)
    if (parsed && typeof parsed === "object" && "query" in parsed) {
      const query = (parsed as { query?: unknown }).query
      if (typeof query === "string" && query.trim()) return query
    }
  } catch {
    /* Fall through to the raw arguments. */
  }
  return call.arguments || "web search"
}

/** Turns executed searches into the parts a client wire can render. */
function searchParts(records: Array<SearchRecord>): Array<IRPart> {
  const parts: Array<IRPart> = []
  for (const record of records) {
    parts.push({
      type: "server_tool_use",
      id: record.callId,
      name: INTERNAL_TOOL_NAME,
      input: JSON.stringify({ query: record.query }),
    })
    if (record.answer)
      parts.push({
        type: "web_search_result",
        toolUseId: record.callId,
        results: record.answer.hits,
      })
  }
  return parts
}

/** Text handed back to the model for one search. */
function resultText(record: SearchRecord): string {
  if (record.error) return `Search failed: ${record.error}`
  const answer = record.answer
  const lines: Array<string> = []
  if (answer?.text) lines.push(answer.text)
  if (answer && answer.hits.length > 0) {
    lines.push("Sources:")
    for (const hit of answer.hits.slice(0, 20)) lines.push(formatHit(hit))
  }
  return lines.length > 0 ? lines.join("\n") : "The search found nothing."
}

function formatHit(hit: SearchHit): string {
  return `- ${hit.title ? `${hit.title} — ` : ""}${hit.url}`
}

/**
 * Runs the searches for one round concurrently: one unusable backend must not
 * sink the others, so each failure becomes an error tool result the model can
 * reason about instead of failing the whole turn.
 */
async function runSearches(
  calls: Array<IRToolCallPart>,
  searchers: Array<Searcher>,
  signal?: AbortSignal,
  initiator?: "agent" | "user",
): Promise<Array<SearchRecord>> {
  const settled = await Promise.all(
    calls.map(async (call): Promise<SearchRecord> => {
      const query = queryFor(call)
      try {
        const answer = await executeWebSearch(
          query,
          searchers,
          signal,
          initiator,
        )
        return { callId: call.id, query, answer }
      } catch (error) {
        return {
          callId: call.id,
          query,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }),
  )
  return settled
}

function appendRound(
  request: RequestIR,
  calls: Array<IRToolCallPart>,
  records: Array<SearchRecord>,
): RequestIR {
  const assistant: IRTurn = { role: "assistant", parts: calls }
  const tool: IRTurn = {
    role: "tool",
    parts: records.map((record) => ({
      type: "tool_result" as const,
      callId: record.callId,
      content: [{ type: "text" as const, text: resultText(record) }],
      ...(record.error && { isError: true }),
    })),
  }
  return { ...request, turns: [...request.turns, assistant, tool] }
}

function finalTurn(): IRTurn {
  return {
    role: "user",
    parts: [{ type: "text", text: NO_MORE_SEARCHES }],
  }
}

function addUsage(
  total: IRUsage | undefined,
  next: IRUsage | undefined,
): IRUsage | undefined {
  if (!next) return total
  if (!total) return next
  const sum = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
  return {
    source: total.source === next.source ? total.source : "mixed",
    inputTokens: sum(total.inputTokens, next.inputTokens),
    outputTokens: sum(total.outputTokens, next.outputTokens),
    cacheReadTokens: sum(total.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: sum(total.cacheWriteTokens, next.cacheWriteTokens),
    reasoningTokens: sum(total.reasoningTokens, next.reasoningTokens),
    totalTokens: sum(total.totalTokens, next.totalTokens),
  }
}

/**
 * Non-streaming loop: keeps asking the target until it stops calling the
 * internal tool (or the round budget runs out), then returns the final result
 * with every executed search prepended as a search part.
 */
export async function runSearchAwareResult(
  params: SearchAwareParams,
): Promise<{ credentialId: string; result: ResultIR }> {
  const internalName = internalToolName(params.request)
  const records: Array<SearchRecord> = []
  let working = roundRequest(params.request, internalName, true)
  let credentialId = ""
  let last: ResultIR | undefined
  let usage: IRUsage | undefined

  for (let round = 1; ; round++) {
    const payload = params.spec.encodeRequest(working, { stream: false })
    const result = await params.execute(payload)
    credentialId = result.credentialId
    const current = params.spec.decodeResult(result.response, {
      model: params.request.model,
      request: params.request,
    })
    last = current
    params.onUsage?.(current.usage)
    usage = addUsage(usage, current.usage)
    const calls = current.parts.filter((part) =>
      isInternalCall(part, internalName),
    )
    if (calls.length === 0 || round > MAX_SEARCH_ROUNDS) break
    const executed = await runSearches(
      calls,
      params.searchers,
      params.signal,
      params.initiator,
    )
    records.push(...executed)
    working = appendRound(working, calls, executed)
  }

  const final = last ?? {
    id: "",
    model: params.request.model,
    source: { wire: params.request.source.wire },
    parts: [],
  }
  return {
    credentialId,
    result: {
      ...final,
      ...(usage && { usage }),
      parts: [...searchParts(records), ...final.parts],
    },
  }
}

/**
 * Streaming loop: each round is streamed through to the client, with the
 * internal tool call's own events suppressed and replaced by search parts.
 *
 * Three things must be normalized because each round is a fresh upstream
 * message (see docs/protocol-translation-pitfalls.md §6):
 *   - block indices are renumbered (every round restarts at 0);
 *   - only the first `message_start` is forwarded;
 *   - intermediate `message_end`s are withheld and usage is summed.
 */
export async function* runSearchAwareStream(
  params: SearchAwareParams,
): AsyncGenerator<StreamEvent> {
  const internalName = internalToolName(params.request)
  const records: Array<SearchRecord> = []
  const indexByPart = new Map<string, number>()
  let nextIndex = 0
  let started = false
  let usage: IRUsage | undefined
  let stop: Extract<StreamEvent, { type: "message_end" }>["stop"]
  let status: Extract<StreamEvent, { type: "message_end" }>["status"]
  let working = roundRequest(params.request, internalName, true)

  const remapIndex = (event: StreamEvent, round: number): StreamEvent => {
    if (
      event.type === "message_start"
      || event.type === "usage"
      || event.type === "message_end"
      || event.type === "error"
    ) {
      return event
    }
    const key = `${round}:${event.partId}`
    let index = indexByPart.get(key)
    if (index === undefined) {
      index = nextIndex++
      indexByPart.set(key, index)
    }
    return { ...event, index }
  }

  /** Emits a search part pair (server tool use + its results). */
  function* emitSearchPart(record: SearchRecord): Generator<StreamEvent> {
    const id = `search_${nextIndex}`
    const index = nextIndex++
    yield {
      type: "part_start",
      partId: id,
      index,
      part: {
        type: "server_tool_use",
        id: record.callId,
        name: INTERNAL_TOOL_NAME,
        input: JSON.stringify({ query: record.query }),
      },
    }
    yield { type: "part_end", partId: id, index }
    if (!record.answer) return
    const resultId = `search_result_${nextIndex}`
    const resultIndex = nextIndex++
    yield {
      type: "part_start",
      partId: resultId,
      index: resultIndex,
      part: {
        type: "web_search_result",
        toolUseId: record.callId,
        results: record.answer.hits,
      },
    }
    yield { type: "part_end", partId: resultId, index: resultIndex }
  }

  for (let round = 1; ; round++) {
    const payload = params.spec.encodeRequest(working, { stream: true })
    const result = await params.execute(payload)
    const calls: Array<IRToolCallPart> = []
    let roundUsage: IRUsage | undefined
    let openInternalPartId: string | undefined
    let openInternalArguments = ""

    for await (const raw of params.spec.decodeStream(
      result.response as Parameters<WireSpec["decodeStream"]>[0],
      { model: params.request.model, request: params.request },
    )) {
      if (raw.type === "message_start") {
        if (!started) {
          started = true
          yield raw
        }
        continue
      }
      if (raw.type === "usage") {
        roundUsage = {
          source: raw.usage.source,
          inputTokens: raw.usage.inputTokens ?? roundUsage?.inputTokens,
          outputTokens: raw.usage.outputTokens ?? roundUsage?.outputTokens,
          cacheReadTokens:
            raw.usage.cacheReadTokens ?? roundUsage?.cacheReadTokens,
          cacheWriteTokens:
            raw.usage.cacheWriteTokens ?? roundUsage?.cacheWriteTokens,
          reasoningTokens:
            raw.usage.reasoningTokens ?? roundUsage?.reasoningTokens,
          totalTokens: raw.usage.totalTokens ?? roundUsage?.totalTokens,
        }
        continue
      }
      if (raw.type === "message_end") {
        stop = raw.stop
        status = raw.status
        continue
      }
      if (raw.type === "error") {
        yield raw
        return
      }
      if (raw.type === "part_start" && isInternalCall(raw.part, internalName)) {
        openInternalPartId = raw.partId
        openInternalArguments = raw.part.arguments
        calls.push({ ...raw.part })
        continue
      }
      if (openInternalPartId !== undefined) {
        if (
          raw.type === "part_delta"
          && raw.partId === openInternalPartId
          && raw.delta.type === "tool_arguments"
        ) {
          openInternalArguments += raw.delta.text
          continue
        }
        if (raw.type === "part_end" && raw.partId === openInternalPartId) {
          const call = calls.at(-1)
          if (call) call.arguments = openInternalArguments
          openInternalPartId = undefined
          continue
        }
        if ("partId" in raw && raw.partId === openInternalPartId) continue
      }
      yield remapIndex(raw, round)
    }
    usage = addUsage(usage, roundUsage)
    params.onUsage?.(roundUsage)
    // A call that never received a part_end still has to be answerable.
    if (openInternalPartId !== undefined) {
      const call = calls.at(-1)
      if (call) call.arguments = openInternalArguments
    }

    if (calls.length === 0 || round > MAX_SEARCH_ROUNDS) break
    const executed = await runSearches(
      calls,
      params.searchers,
      params.signal,
      params.initiator,
    )
    records.push(...executed)
    for (const record of executed) yield* emitSearchPart(record)
    working = appendRound(working, calls, executed)
    if (round === MAX_SEARCH_ROUNDS)
      working = { ...working, turns: [...working.turns, finalTurn()] }
  }

  if (usage) yield { type: "usage", usage }
  yield {
    type: "message_end",
    stop: stop ?? { reason: "incomplete" },
    status: status ?? (stop ? "completed" : "incomplete"),
  }
}
