import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

interface NormalizedOutputState {
  callId?: string
  itemId?: string
}

interface NormalizationState {
  outputs: Map<number, NormalizedOutputState>
  responseId?: string
}

export async function* normalizeResponsesStreamIds(
  response: AsyncIterable<CopilotStreamEventLike>,
): AsyncIterable<CopilotStreamEventLike> {
  const state: NormalizationState = {
    outputs: new Map(),
  }

  for await (const event of response) {
    if (!event.data || event.data === "[DONE]") {
      yield event
      continue
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>
    } catch {
      yield event
      continue
    }

    normalizeParsedEvent(parsed, state)
    yield {
      ...event,
      data: JSON.stringify(parsed),
    }
  }
}

function normalizeParsedEvent(
  parsed: Record<string, unknown>,
  state: NormalizationState,
): void {
  normalizeResponseId(parsed, state)

  const type = getString(parsed.type)
  if (!type) {
    return
  }

  switch (type) {
    case "response.output_item.added":
    case "response.output_item.done": {
      const outputIndex = getNumber(parsed.output_index)
      const item = getRecord(parsed.item)
      if (outputIndex !== undefined && item) {
        normalizeOutputItem(item, outputIndex, state)
      }
      return
    }
    case "response.completed":
    case "response.created":
    case "response.failed":
    case "response.in_progress":
    case "response.incomplete": {
      const response = getRecord(parsed.response)
      if (!response) {
        return
      }
      const output = getArray(response.output)
      if (!output) {
        return
      }
      for (const [index, item] of output.entries()) {
        const record = getRecord(item)
        if (record) {
          normalizeOutputItem(record, index, state)
        }
      }
      return
    }
    default: {
      const outputIndex = getNumber(parsed.output_index)
      if (outputIndex === undefined) {
        return
      }
      normalizeIndexedEvent(parsed, outputIndex, state)
    }
  }
}

function normalizeResponseId(
  parsed: Record<string, unknown>,
  state: NormalizationState,
): void {
  const response = getRecord(parsed.response)
  if (response) {
    const responseId = getString(response.id)
    if (!state.responseId && responseId) {
      state.responseId = responseId
    }
    if (state.responseId) {
      response.id = state.responseId
    }
  }

  const responseId = getString(parsed.response_id)
  if (!state.responseId && responseId) {
    state.responseId = responseId
  }
  if (state.responseId && responseId !== undefined) {
    parsed.response_id = state.responseId
  }
}

function normalizeOutputItem(
  item: Record<string, unknown>,
  outputIndex: number,
  state: NormalizationState,
): void {
  const outputState = getOrCreateOutputState(
    state,
    outputIndex,
    getString(item.id),
    getString(item.call_id),
  )

  if (outputState.itemId) {
    item.id = outputState.itemId
  }

  if (outputState.callId && Object.hasOwn(item, "call_id")) {
    item.call_id = outputState.callId
  }
}

function normalizeIndexedEvent(
  parsed: Record<string, unknown>,
  outputIndex: number,
  state: NormalizationState,
): void {
  const outputState = getOrCreateOutputState(
    state,
    outputIndex,
    getString(parsed.item_id),
    getString(parsed.call_id),
  )

  if (outputState.itemId && Object.hasOwn(parsed, "item_id")) {
    parsed.item_id = outputState.itemId
  }

  if (outputState.callId && Object.hasOwn(parsed, "call_id")) {
    parsed.call_id = outputState.callId
  }
}

function getOrCreateOutputState(
  state: NormalizationState,
  outputIndex: number,
  itemId?: string,
  callId?: string,
): NormalizedOutputState {
  const existing = state.outputs.get(outputIndex)
  if (existing) {
    if (!existing.itemId && itemId) {
      existing.itemId = itemId
    }
    if (!existing.callId && callId) {
      existing.callId = callId
    }
    return existing
  }

  const created: NormalizedOutputState = {
    itemId: itemId ?? `item_${outputIndex}`,
    ...(callId ? { callId } : {}),
  }
  state.outputs.set(outputIndex, created)
  return created
}

function getArray(value: unknown): Array<unknown> | undefined {
  return Array.isArray(value) ? value : undefined
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}
