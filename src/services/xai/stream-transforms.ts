import { createHash } from "node:crypto"

import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"

import { cacheReasoningReplayItems } from "~/lib/cache/reasoning-replay-cache"
import { logger } from "~/lib/logger"
import { recordResponsesTranscriptInStream } from "~/services/responses/transcript-cache"

import {
  restoreXaiNamespaceToolCalls,
  type XaiNamespaceToolRef,
} from "./sanitize-body"
import type { XaiInternalXSearchResponseFilter } from "./search-filter"

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12)
}

export function logCachePrefixDiag(
  sessionId: string | undefined,
  payload: ResponsesPayload,
): void {
  const instructions = payload.instructions ?? ""
  const instrHash = instructions ? shortHash(instructions) : "(none)"
  const instrLen = instructions.length

  const toolsJson = payload.tools ? JSON.stringify(payload.tools) : ""
  const toolsHash = toolsJson ? shortHash(toolsJson) : "(none)"
  const toolsLen = toolsJson.length

  let inputCount = 0
  let inputTypes: Array<string> = []
  let inputPrefixHash = "(none)"
  if (typeof payload.input === "string") {
    inputCount = 1
    inputTypes = ["string"]
    inputPrefixHash = shortHash(payload.input.slice(0, 2048))
  } else if (Array.isArray(payload.input)) {
    inputCount = payload.input.length
    inputTypes = payload.input.slice(0, 20).map((item) => {
      if (typeof item === "string") return "string"
      if ("type" in item) return item.type
      if ("role" in item) return item.role
      return "unknown"
    })
    const inputPrefix = JSON.stringify(payload.input.slice(0, 10)).slice(
      0,
      4096,
    )
    inputPrefixHash = shortHash(inputPrefix)
  }

  logger.debug(
    `[xAI cache-diag] session=${sessionId ?? "(none)"} `
      + `instr=${instrHash}(${instrLen}) tools=${toolsHash}(${toolsLen}) `
      + `input_prefix=${inputPrefixHash} `
      + `types=[${inputTypes.join(",")}] input_count=${inputCount}`,
  )
}

interface XaiReasoningReplayContext {
  model?: string
  sessionId?: string
}

export function recordXaiTranscript(
  stream: AsyncIterable<CopilotStreamEventLike>,
  transcriptKey: string,
  fullInputThisTurn: Array<unknown>,
  replay: XaiReasoningReplayContext,
  memoryTraceId?: string,
): AsyncIterable<CopilotStreamEventLike> {
  return recordResponsesTranscriptInStream(
    stream,
    transcriptKey,
    fullInputThisTurn,
    memoryTraceId,
    (parsed) => {
      if (
        replay.model
        && replay.sessionId
        && parsed.type === "response.completed"
      ) {
        void cacheReasoningReplayItems(replay.model, replay.sessionId, parsed)
      }
    },
  )
}

export async function* filterXaiInternalSearchInStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  searchFilter: XaiInternalXSearchResponseFilter,
): AsyncIterable<CopilotStreamEventLike> {
  for await (const event of stream) {
    if (event.data && event.data !== "[DONE]") {
      const filteredData = searchFilter.apply(event.data)
      if (filteredData === null) {
        continue
      }
      yield filteredData === event.data ?
        event
      : { ...event, data: filteredData }
    } else {
      yield event
    }
  }
}

export async function* cacheXaiReasoningReplayInStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  model?: string,
  sessionId?: string,
): AsyncIterable<CopilotStreamEventLike> {
  if (!model || !sessionId) {
    yield* stream
    return
  }
  for await (const event of stream) {
    const data = event.data
    if (data && data !== "[DONE]" && data.includes('"response.completed"')) {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        if (parsed.type === "response.completed") {
          void cacheReasoningReplayItems(model, sessionId, parsed)
        }
      } catch {
        // Best-effort reasoning replay caching.
      }
    }
    yield event
  }
}

export async function* restoreXaiNamespaceCallsInStream(
  stream: AsyncIterable<CopilotStreamEventLike>,
  refs: Map<string, XaiNamespaceToolRef>,
): AsyncIterable<CopilotStreamEventLike> {
  if (refs.size === 0) {
    yield* stream
    return
  }
  for await (const event of stream) {
    if (event.data && event.data !== "[DONE]") {
      const restored = restoreXaiNamespaceToolCalls(event.data, refs)
      yield restored === event.data ? event : { ...event, data: restored }
    } else {
      yield event
    }
  }
}

export function restoreXaiNamespaceToolCallsInResponse(
  response: ResponsesResponse,
  refs: Map<string, XaiNamespaceToolRef>,
): void {
  if (refs.size === 0 || !Array.isArray(response.output)) return
  for (const item of response.output) {
    if (typeof item !== "object") continue
    const record = item as unknown as Record<string, unknown>
    if (record.type !== "function_call") continue
    const qualified = typeof record.name === "string" ? record.name.trim() : ""
    const ref = refs.get(qualified)
    if (!ref) continue
    record.name = ref.name
    record.namespace = ref.namespace
  }
}
