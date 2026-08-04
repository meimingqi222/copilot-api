import type { ResponsesResponse } from "~/services/copilot/responses-api"

import { HTTPError } from "~/lib/error"
import { readResponseBytes } from "~/lib/request-body"

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

function patchCompletedOutput(
  completedEvent: Record<string, unknown>,
  outputItemsByIndex: Map<number, Record<string, unknown>>,
  outputItemsFallback: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const response = getRecord(completedEvent.response)
  if (!response) {
    return completedEvent
  }

  const existingOutput = response.output
  const hasOutput = Array.isArray(existingOutput) && existingOutput.length > 0
  if (
    hasOutput
    || (outputItemsByIndex.size === 0 && outputItemsFallback.length === 0)
  ) {
    return completedEvent
  }

  const patchedOutput: Array<Record<string, unknown>> = []
  for (const index of [...outputItemsByIndex.keys()].sort((a, b) => a - b)) {
    const item = outputItemsByIndex.get(index)
    if (item) {
      patchedOutput.push(item)
    }
  }
  patchedOutput.push(...outputItemsFallback)

  return {
    ...completedEvent,
    response: {
      ...response,
      output: patchedOutput,
    },
  }
}

export function collectResponsesFromSseText(
  text: string,
  model: string,
): ResponsesResponse {
  const outputItemsByIndex = new Map<number, Record<string, unknown>>()
  const outputItemsFallback: Array<Record<string, unknown>> = []
  let completedEvent: Record<string, unknown> | undefined
  let terminalError: string | undefined

  for (const line of text.split("\n")) {
    const event = parseEventData(line)
    if (!event) {
      continue
    }

    const type = typeof event.type === "string" ? event.type : ""
    if (type === "error" || type === "response.failed") {
      const error = getRecord(event.error) ?? getRecord(event.response)
      terminalError = typeof error?.message === "string" ? error.message : type
      continue
    }

    if (type === "response.output_item.done") {
      const item = getRecord(event.item)
      const outputIndex =
        typeof event.output_index === "number" ? event.output_index : undefined
      if (item) {
        if (outputIndex !== undefined) {
          outputItemsByIndex.set(outputIndex, item)
        } else {
          outputItemsFallback.push(item)
        }
      }
      continue
    }

    if (type === "response.completed") {
      completedEvent = patchCompletedOutput(
        event,
        outputItemsByIndex,
        outputItemsFallback,
      )
    }
  }

  if (terminalError) {
    throw new HTTPError(
      terminalError,
      new Response(null, { status: 400 }),
      terminalError,
    )
  }

  if (!completedEvent) {
    throw new Error(
      "Upstream responses stream ended before response.completed event",
    )
  }

  const response = getRecord(completedEvent.response)
  if (!response) {
    throw new Error("response.completed event missing response object")
  }

  return {
    ...(response as unknown as ResponsesResponse),
    model: typeof response.model === "string" ? response.model : model,
  }
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
