import { randomUUID } from "node:crypto"

import { extractReasoningTextAlias } from "~/lib/thinking"
import type {
  ChatCompletionChunk,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import {
  envelopeFailure,
  LingxiError,
  record,
} from "~/services/wps-lingxi/client"

function chatChunkWriter(model: string) {
  const info = {
    id: `chatcmpl-lingxi-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    object: "chat.completion.chunk",
    model,
  } as const
  return (
    choices: ChatCompletionChunk["choices"],
    usage?: ChatCompletionChunk["usage"],
  ): CopilotStreamEvent => ({
    data: JSON.stringify({ ...info, choices, ...(usage && { usage }) }),
  })
}

function tokens(value: unknown): number | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim()))
    return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function lingxiUsage(raw: unknown): ChatCompletionChunk["usage"] {
  const usage = record(raw)
  const prompt = tokens(usage.prompt_tokens ?? usage.input_tokens)
  const completion = tokens(usage.completion_tokens ?? usage.output_tokens)
  if (prompt === undefined || completion === undefined) return undefined
  const cached = tokens(
    usage.cached_tokens ?? record(usage.prompt_tokens_details).cached_tokens,
  )
  const reasoning = tokens(
    usage.reasoning_tokens
      ?? record(usage.completion_tokens_details).reasoning_tokens,
  )
  // Lingxi's total_tokens also includes accumulated context, not just this turn.
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached !== undefined && {
      prompt_tokens_details: { cached_tokens: cached },
    }),
    ...(reasoning !== undefined && {
      completion_tokens_details: { reasoning_tokens: reasoning },
    }),
  }
}

async function* dataLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let finished = false
  try {
    while (!finished) {
      const next = await reader.read()
      finished = next.done
      pending += decoder.decode(next.value, { stream: !finished })
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      if (pending.length > 4 * 1024 * 1024)
        throw new LingxiError(502, "invalid_stream_frame")
      if (finished && pending.trim()) lines.push(pending)
      for (const line of lines) {
        const value = line.trim()
        // Some Lingxi versions omit the SSE blank line between JSON records.
        if (value.startsWith("data:")) yield value.slice(5).trim()
        else if (value.startsWith("{")) yield value
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

type Choice = ChatCompletionChunk["choices"][number]

function toolDelta(
  call: unknown,
  offset: number,
): NonNullable<Choice["delta"]["tool_calls"]>[number] {
  const value = record(call)
  const fn = record(value.function)
  const index =
    (
      typeof value.index === "number"
      && Number.isSafeInteger(value.index)
      && value.index >= 0
    ) ?
      value.index
    : offset
  return {
    index,
    ...(typeof value.id === "string"
      && value.id && { id: value.id, type: "function" }),
    function: {
      ...(typeof fn.name === "string" && fn.name && { name: fn.name }),
      ...(typeof fn.arguments === "string" && { arguments: fn.arguments }),
    },
  }
}

function parseChoice(choice: Record<string, unknown>): Choice["delta"] {
  const delta = record(choice.delta)
  const text = choice.text ?? delta.content
  const reasoning =
    extractReasoningTextAlias(choice) || extractReasoningTextAlias(delta)
  const calls = choice.tool_calls ?? delta.tool_calls
  return {
    ...(typeof text === "string" && text && { content: text }),
    ...(reasoning && { reasoning_content: reasoning }),
    ...(Array.isArray(calls)
      && calls.length && { tool_calls: calls.map(toolDelta) }),
  }
}

export async function* lingxiSse(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<CopilotStreamEvent> {
  const write = chatChunkWriter(model)
  let started = false
  let sawTools = false
  let usage: ChatCompletionChunk["usage"]
  for await (const line of dataLines(body)) {
    const done = line === "[DONE]"
    const frame = done ? {} : parseFrame(line)
    if (!frame) continue
    const failure = envelopeFailure(frame)
    if (failure) throw failure
    usage = lingxiUsage(frame.usage) ?? usage
    let finish: unknown = done ? "stop" : undefined
    for (const item of Array.isArray(frame.choices) ? frame.choices : []) {
      const choice = record(item)
      const delta = parseChoice(choice)
      finish = choice.finish_reason || finish
      if (!Object.keys(delta).length) continue
      sawTools ||= Boolean(delta.tool_calls?.length)
      yield write([
        {
          index: 0,
          delta: started ? delta : { role: "assistant", ...delta },
          finish_reason: null,
          logprobs: null,
        },
      ])
      started = true
    }
    if (!finish) continue
    const reason =
      finish === "length" || finish === "content_filter" ? finish
      : finish === "tool_calls" || sawTools ? "tool_calls"
      : "stop"
    yield write([
      {
        index: 0,
        delta: started ? {} : { role: "assistant" },
        finish_reason: reason,
        logprobs: null,
      },
    ])
    if (usage) yield write([], usage)
    yield { data: "[DONE]" }
    return
  }
  throw new LingxiError(502, "truncated_stream")
}

function parseFrame(line: string): Record<string, unknown> | undefined {
  if (!line) return undefined
  if (line.length > 4 * 1024 * 1024)
    throw new LingxiError(502, "invalid_stream_frame")
  try {
    return record(JSON.parse(line))
  } catch {
    throw new LingxiError(502, "invalid_stream_frame")
  }
}
