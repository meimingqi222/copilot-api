import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type {
  IRPart,
  IRUsage,
  RequestIR,
  ResultIR,
  StreamEvent,
} from "~/services/ir/types"

import {
  decodeResponsesResult,
  encodeResponsesResult,
  restoreResponsesToolNamespace,
  webSearchCallItem,
} from "./result"

type WireRecord = Record<string, unknown>

function record(value: unknown): WireRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as WireRecord)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function parse(data: string | undefined): WireRecord | undefined {
  if (!data || data === "[DONE]") return undefined
  return record(JSON.parse(data) as unknown)
}

function responseFromRecord(value: unknown): ResponsesResponse | undefined {
  const response = record(value)
  if (
    !response
    || typeof response.id !== "string"
    || typeof response.model !== "string"
  )
    return undefined
  return response as unknown as ResponsesResponse
}

function decodeAddedPart(
  item: WireRecord,
  index: number,
  source: ResultIR["source"],
): IRPart | undefined {
  if (item.type === "message") return { type: "text", text: "" }
  if (item.type === "reasoning") return { type: "thinking", text: "", source }
  if (item.type !== "function_call") return undefined
  const namespace = text(item.namespace)
  const name = text(item.name) ?? "unknown_function"
  return {
    type: "tool_call",
    id: text(item.call_id) ?? text(item.id) ?? `call_${index}`,
    name: namespace ? `${namespace}__${name}` : name,
    arguments: text(item.arguments) ?? "",
    ...(namespace ? { namespace, originalName: name } : {}),
  }
}

function* terminalMissingEvents(
  response: ResponsesResponse,
  populated: ReadonlySet<number>,
  reasoningPopulated: boolean,
  startIndex: number,
): Iterable<StreamEvent> {
  let nextIndex = startIndex
  for (const [outputIndex, item] of (response.output ?? []).entries()) {
    if (
      populated.has(outputIndex)
      || (item.type === "reasoning" && reasoningPopulated)
    )
      continue
    const missing = decodeResponsesResult({ ...response, output: [item] })
    for (const part of missing.parts) {
      const index = nextIndex++
      const partId = `terminal_${index}`
      if (part.type === "text" || part.type === "thinking") {
        yield { type: "part_start", partId, index, part: { ...part, text: "" } }
        if (part.text)
          yield {
            type: "part_delta",
            partId,
            index,
            delta: { type: part.type, text: part.text },
          }
      } else {
        yield { type: "part_start", partId, index, part }
      }
      yield { type: "part_end", partId, index }
    }
  }
}

/** Decode Responses SSE one event at a time; no full-stream buffering. */
export async function* decodeResponsesStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  model: string,
): AsyncIterable<StreamEvent> {
  const source = { wire: "responses" as const, model }
  const started = new Map<number, { id: string; part: IRPart }>()
  const populated = new Set<number>()
  let reasoningPopulated = false
  let messageStarted = false
  let nextIndex = 0
  let responseId = ""
  for await (const raw of stream) {
    if (raw.data === "[DONE]") break
    const wire = parse(raw.data)
    if (!wire) continue
    const type = text(wire.type)
    if (type === "error" || type === "response.failed") {
      const error = record(wire.error)
      yield {
        type: "error",
        error: {
          type: text(error?.type) ?? type,
          message:
            text(error?.message)
            ?? text(wire.message)
            ?? "Responses stream failed",
        },
      }
      return
    }
    if (type === "response.created" || type === "response.in_progress") {
      const response = responseFromRecord(wire.response)
      if (response && !messageStarted) {
        responseId = response.id
        messageStarted = true
        yield {
          type: "message_start",
          id: response.id,
          model: response.model,
          source,
          createdAt: response.created_at,
        }
      }
      continue
    }
    const wireResponseId = text(wire.response_id)
    if (wireResponseId) responseId = wireResponseId
    const terminalResponse =
      type === "response.completed" || type === "response.incomplete" ?
        responseFromRecord(wire.response)
      : undefined
    if (terminalResponse) responseId = terminalResponse.id
    if (!messageStarted) {
      messageStarted = true
      yield {
        type: "message_start",
        id: responseId || "resp_unknown",
        model: terminalResponse?.model ?? model,
        source,
        createdAt: terminalResponse?.created_at,
      }
    }
    if (type === "response.output_item.added") {
      const item = record(wire.item)
      const index = number(wire.output_index) ?? nextIndex++
      nextIndex = Math.max(nextIndex, index + 1)
      if (!item) continue
      const part = decodeAddedPart(item, index, source)
      if (!part) continue
      const partId = text(item.id) ?? `${part.type}_${index}`
      started.set(index, { id: partId, part })
      if (part.type === "tool_call") populated.add(index)
      yield { type: "part_start", partId, index, part }
      continue
    }
    if (
      type === "response.output_text.delta"
      || type === "response.reasoning_summary_text.delta"
      || type === "response.function_call_arguments.delta"
    ) {
      const index =
        number(wire.output_index)
        ?? (type === "response.reasoning_summary_text.delta" ? -1 : 0)
      let current = started.get(index)
      if (!current && type === "response.output_text.delta") {
        const partId = `text_${index}`
        const part: IRPart = { type: "text", text: "" }
        current = { id: partId, part }
        started.set(index, current)
        yield { type: "part_start", partId, index, part }
      }
      if (!current && type === "response.reasoning_summary_text.delta") {
        const partId = `thinking_${index}`
        const part: IRPart = { type: "thinking", text: "", source }
        current = { id: partId, part }
        started.set(index, current)
        yield { type: "part_start", partId, index, part }
      }
      if (!current) continue
      const delta = text(wire.delta)
      if (!delta) continue
      populated.add(index)
      if (type === "response.reasoning_summary_text.delta")
        reasoningPopulated = true
      yield {
        type: "part_delta",
        partId: current.id,
        index,
        delta:
          type === "response.function_call_arguments.delta" ?
            { type: "tool_arguments", text: delta }
          : type === "response.reasoning_summary_text.delta" ?
            { type: "thinking", text: delta }
          : { type: "text", text: delta },
      }
      continue
    }
    if (type === "response.output_item.done") {
      const index = number(wire.output_index)
      const current = index !== undefined ? started.get(index) : undefined
      if (current && index !== undefined) {
        yield { type: "part_end", partId: current.id, index }
        started.delete(index)
      }
      continue
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const response = responseFromRecord(wire.response)
      if (response) {
        const result = decodeResponsesResult(response)
        // Recover items that appeared only in the terminal response object.
        yield* terminalMissingEvents(
          response,
          populated,
          reasoningPopulated,
          nextIndex,
        )
        if (result.usage) yield { type: "usage", usage: result.usage }
        yield { type: "message_end", stop: result.stop, status: result.status }
      } else {
        yield {
          type: "message_end",
          stop: { reason: "unknown" },
          status: type === "response.incomplete" ? "incomplete" : "completed",
        }
      }
      return
    }
  }
  if (messageStarted)
    yield {
      type: "message_end",
      stop: { reason: "incomplete", raw: "upstream_stream_ended" },
      status: "incomplete",
    }
}

function event(type: string, fields: WireRecord): CopilotStreamEventLike {
  return { data: JSON.stringify({ type, ...fields }) }
}

function updatePart(
  part: IRPart,
  delta: StreamEvent & { type: "part_delta" },
): IRPart {
  if (part.type === "text" && delta.delta.type === "text")
    return { ...part, text: part.text + delta.delta.text }
  if (part.type === "thinking" && delta.delta.type === "thinking")
    return { ...part, text: part.text + delta.delta.text }
  if (part.type === "tool_call" && delta.delta.type === "tool_arguments")
    return { ...part, arguments: part.arguments + delta.delta.text }
  return part
}

/** Encode IR events incrementally, retaining only the result needed for the final Responses object. */
export async function* encodeResponsesStream(
  stream: AsyncIterable<StreamEvent>,
  request?: RequestIR | ResponsesPayload,
): AsyncIterable<CopilotStreamEventLike> {
  const parts = new Map<number, IRPart>()
  let responseId = "resp_unknown"
  let model = request?.model ?? "unknown"
  let source: ResultIR["source"] = { wire: "responses" }
  let createdAt: number | undefined
  let usage: IRUsage | undefined
  let started = false
  let pendingSearchCall: { index: number; partId: string } | undefined
  /** Emits the deferred `output_item.done` for a search call, if one is held. */
  const flushPendingSearchCall = (): CopilotStreamEventLike | undefined => {
    if (!pendingSearchCall) return undefined
    const { index, partId } = pendingSearchCall
    pendingSearchCall = undefined
    const part = parts.get(index)
    if (part?.type !== "server_tool_use") return undefined
    return event("response.output_item.done", {
      response_id: responseId,
      output_index: index,
      item: webSearchCallItem(part, partId),
    })
  }
  const start = (): CopilotStreamEventLike =>
    event("response.created", {
      response: {
        id: responseId,
        object: "response",
        model,
        status: "in_progress",
        output: [],
        created_at: createdAt ?? Math.floor(Date.now() / 1000),
      },
    })
  for await (const current of stream) {
    if (current.type === "error") {
      yield event("error", { error: current.error })
      return
    }
    if (current.type === "message_start") {
      responseId = current.id
      model = current.model
      source = current.source
      createdAt = current.createdAt
      if (!started) {
        started = true
        yield start()
      }
      continue
    }
    if (!started) {
      started = true
      yield start()
    }
    if (current.type === "part_start") {
      // A search's sources arrive as a separate `web_search_result` part right
      // after the call, but Responses reports both in one item — so the call's
      // `output_item.done` is deferred until the result has been merged in.
      const pendingDone = flushPendingSearchCall()
      if (pendingDone) yield pendingDone
      const part = restoreResponsesToolNamespace(current.part, request)
      parts.set(current.index, part)
      if (part.type === "server_tool_use") {
        yield event("response.output_item.added", {
          response_id: responseId,
          output_index: current.index,
          item: webSearchCallItem(part, current.partId),
        })
        pendingSearchCall = { index: current.index, partId: current.partId }
        continue
      }
      if (part.type === "web_search_result") {
        // Merged into the stashed call when its `done` event flushes.
        const stashed =
          pendingSearchCall ? parts.get(pendingSearchCall.index) : undefined
        if (
          stashed
          && pendingSearchCall
          && stashed.type === "server_tool_use"
          && stashed.id === part.toolUseId
        ) {
          parts.set(pendingSearchCall.index, {
            ...stashed,
            input: JSON.stringify(
              webSearchCallItem(stashed, pendingSearchCall.partId, part.results)
                .action,
            ),
          })
        }
        continue
      }
      if (part.type === "text") {
        yield event("response.output_item.added", {
          response_id: responseId,
          output_index: current.index,
          item: {
            type: "message",
            id: current.partId,
            role: "assistant",
            content: [],
          },
        })
      } else if (part.type === "tool_call") {
        yield event("response.output_item.added", {
          response_id: responseId,
          output_index: current.index,
          item: {
            type: "function_call",
            id: current.partId,
            call_id: part.id,
            name: part.originalName ?? part.name,
            ...(part.namespace ? { namespace: part.namespace } : {}),
            arguments: part.arguments,
          },
        })
      } else if (part.type === "thinking") {
        yield event("response.output_item.added", {
          response_id: responseId,
          output_index: current.index,
          item: { type: "reasoning", id: current.partId, summary: [] },
        })
      }
      continue
    }
    if (current.type === "part_delta") {
      const part = parts.get(current.index)
      if (part) parts.set(current.index, updatePart(part, current))
      if (current.delta.type === "text")
        yield event("response.output_text.delta", {
          response_id: responseId,
          output_index: current.index,
          delta: current.delta.text,
        })
      else if (current.delta.type === "thinking")
        yield event("response.reasoning_summary_text.delta", {
          response_id: responseId,
          output_index: current.index,
          delta: current.delta.text,
        })
      else if (current.delta.type === "tool_arguments")
        yield event("response.function_call_arguments.delta", {
          response_id: responseId,
          output_index: current.index,
          item_id: current.partId,
          delta: current.delta.text,
        })
      continue
    }
    if (current.type === "part_end") {
      // A search call's `done` waits for its result part (see above).
      if (pendingSearchCall && pendingSearchCall.index === current.index)
        continue
      const part = parts.get(current.index)
      if (part)
        yield event("response.output_item.done", {
          response_id: responseId,
          output_index: current.index,
          item: part,
        })
      continue
    }
    if (current.type === "usage") {
      usage = current.usage
      continue
    }
    if (current.type === "message_end") {
      const pendingDone = flushPendingSearchCall()
      if (pendingDone) yield pendingDone
      const result: ResultIR = {
        id: responseId,
        model,
        source,
        parts: [...parts.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, part]) => part),
        usage,
        stop: current.stop,
        status: current.status,
        createdAt,
      }
      yield event("response.completed", {
        response: encodeResponsesResult(result, request),
      })
      return
    }
  }
  if (started) {
    const result: ResultIR = {
      id: responseId,
      model,
      source,
      parts: [...parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, part]) => part),
      usage,
      stop: { reason: "incomplete", raw: "upstream_stream_ended" },
      status: "incomplete",
      createdAt,
    }
    yield event("response.completed", {
      response: encodeResponsesResult(result, request),
    })
  }
}
