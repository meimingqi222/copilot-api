import type {
  CopilotStreamEventLike,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { HTTPError } from "~/lib/error"
import { readResponseBytes } from "~/lib/request-body"

import {
  extractWsErrorMessage,
  extractWsErrorStatus,
} from "./upstream-ws-error"

const MAX_COLLECTED_SSE_BYTES = 32 * 1024 * 1024

function parseEventData(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) {
    return undefined
  }
  const payload = trimmed.slice(5).trim()
  if (!payload || payload === "[DONE]") {
    return undefined
  }
  try {
    return JSON.parse(payload) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

interface ResponsesCollectorState {
  outputItemsByIndex: Map<number, Record<string, unknown>>
  outputItemsFallback: Array<Record<string, unknown>>
  terminalEvent?: Record<string, unknown>
}

function patchTerminalOutput(
  terminalEvent: Record<string, unknown>,
  outputItemsByIndex: Map<number, Record<string, unknown>>,
  outputItemsFallback: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const response = getRecord(terminalEvent.response)
  if (!response) {
    return terminalEvent
  }

  const existingOutput: Array<unknown> =
    Array.isArray(response.output) ? (response.output as Array<unknown>) : []
  if (outputItemsByIndex.size === 0 && outputItemsFallback.length === 0) {
    return terminalEvent
  }

  const patchedOutput: Array<unknown> = [...existingOutput]
  for (const [index, value] of patchedOutput.entries()) {
    const item = getRecord(value)
    if (!item || nonEmptyString(item.id)) continue
    const observedId = stateItemId(outputItemsByIndex.get(index))
    if (observedId) item.id = observedId
  }
  for (const [index, item] of [...outputItemsByIndex.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    // A non-empty terminal output is an authoritative prefix. Append only
    // indexed items already observed beyond that prefix; never guess at an
    // unobserved middle gap.
    if (index >= patchedOutput.length && !hasOutputItem(patchedOutput, item)) {
      patchedOutput.push(item)
    }
  }
  for (const item of outputItemsFallback) {
    // Without output_index, require stable identity before deciding this is a
    // missing terminal item rather than a duplicate frame.
    if (outputItemKey(item) && !hasOutputItem(patchedOutput, item)) {
      patchedOutput.push(item)
    }
  }

  return {
    ...terminalEvent,
    response: {
      ...response,
      output: patchedOutput,
    },
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function stateItemId(
  item: Record<string, unknown> | undefined,
): string | undefined {
  return item ? nonEmptyString(item.id) : undefined
}

function hasOutputItem(
  output: Array<unknown>,
  candidate: Record<string, unknown>,
): boolean {
  const candidateKey = outputItemKey(candidate)
  if (!candidateKey) return false
  return output.some((value) => {
    const item = getRecord(value)
    return item ? outputItemKey(item) === candidateKey : false
  })
}

function outputItemKey(item: Record<string, unknown>): string | undefined {
  const type = typeof item.type === "string" ? item.type.trim() : ""
  const id = typeof item.id === "string" ? item.id.trim() : ""
  if (id) return `${type}:id:${id}`
  const callId = typeof item.call_id === "string" ? item.call_id.trim() : ""
  return callId ? `${type}:call_id:${callId}` : undefined
}

function createTerminalError(event: Record<string, unknown>): HTTPError {
  const response = getRecord(event.response)
  const error = getRecord(event.error) ?? getRecord(response?.error)
  const message = extractWsErrorMessage(event)
  const status = extractWsErrorStatus(event)
  const headers = new Headers()
  const retryAfter = error?.resets_in_seconds
  if (typeof retryAfter === "number" && retryAfter > 0) {
    headers.set("Retry-After", String(retryAfter))
  }

  // Normalize the nested response.failed shape to the standard top-level
  // error envelope. Dispatch and downstream error serialization can then keep
  // type/code/message and classify quota/auth/rate failures correctly.
  const responseBody = JSON.stringify({
    error: error ?? { message, type: "error" },
  })
  return new HTTPError(
    message,
    new Response(null, { status, headers }),
    responseBody,
  )
}

function consumeResponsesEvent(
  state: ResponsesCollectorState,
  event: Record<string, unknown>,
): void {
  const type = typeof event.type === "string" ? event.type : ""
  if (type === "error" || type === "response.failed") {
    throw createTerminalError(event)
  }

  if (type === "response.output_item.done") {
    const item = getRecord(event.item)
    const outputIndex =
      typeof event.output_index === "number" ? event.output_index : undefined
    if (item) {
      if (outputIndex !== undefined) {
        state.outputItemsByIndex.set(outputIndex, item)
      } else {
        state.outputItemsFallback.push(item)
      }
    }
    return
  }

  if (type === "response.completed" || type === "response.incomplete") {
    state.terminalEvent = patchTerminalOutput(
      event,
      state.outputItemsByIndex,
      state.outputItemsFallback,
    )
  }
}

function finishResponsesCollection(
  state: ResponsesCollectorState,
  model: string,
): ResponsesResponse {
  if (!state.terminalEvent) {
    throw new Error(
      "Upstream responses stream ended before a terminal response event",
    )
  }

  const response = getRecord(state.terminalEvent.response)
  if (!response) {
    throw new Error("Terminal response event missing response object")
  }

  return {
    ...(response as unknown as ResponsesResponse),
    model: typeof response.model === "string" ? response.model : model,
  }
}

function createCollectorState(): ResponsesCollectorState {
  return {
    outputItemsByIndex: new Map(),
    outputItemsFallback: [],
  }
}

export function collectResponsesFromSseText(
  text: string,
  model: string,
): ResponsesResponse {
  const state = createCollectorState()

  let lineStart = 0
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf("\n", lineStart)
    const line =
      lineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEnd)
    lineStart = lineEnd === -1 ? text.length + 1 : lineEnd + 1
    const event = parseEventData(line)
    if (!event) {
      continue
    }

    consumeResponsesEvent(state, event)
  }

  return finishResponsesCollection(state, model)
}

/** Collect a normalized Responses event iterable into its terminal response. */
export async function collectResponsesFromEventStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  model: string,
): Promise<ResponsesResponse> {
  const state = createCollectorState()
  for await (const event of stream) {
    if (!event.data || event.data === "[DONE]") continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>
    } catch {
      continue
    }
    consumeResponsesEvent(state, parsed)
  }
  return finishResponsesCollection(state, model)
}

export async function collectResponsesFromSseResponse(
  response: Response,
  model: string,
): Promise<ResponsesResponse> {
  const text = new TextDecoder().decode(
    await readResponseBytes(response, MAX_COLLECTED_SSE_BYTES),
  )
  return collectResponsesFromSseText(text, model)
}
