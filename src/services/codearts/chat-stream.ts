import { HTTPError } from "~/lib/error"
import { asRecord, asRecordOrEmpty, asTrimmedString } from "~/lib/json-shape"
import { extractReasoningTextAlias } from "~/lib/thinking"
import { safeSseStream } from "~/services/protocols/shared"
import type {
  ChatCompletionChunk,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"

function parse(text: string | undefined): Record<string, unknown> | undefined {
  if (!text || text === "[DONE]") return undefined
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return undefined
  }
}

export function codeArtsError(text: string, response?: Response): HTTPError {
  const raw = parse(text)
  const nested = asRecordOrEmpty(raw?.error)
  const code =
    asTrimmedString(nested.code ?? raw?.error_code ?? raw?.code) ?? ""
  const message =
    asTrimmedString(nested.message ?? raw?.error_msg ?? raw?.message)
    ?? `CodeArts upstream error (${response?.status ?? "SSE"})`
  const diagnosis = `${code} ${message}`
  let status = response && !response.ok ? response.status : 502
  if (/body too large/i.test(diagnosis)) status = 413
  else if (/not multimodal|InferHub\.001001020\.406/i.test(diagnosis))
    status = 400
  else if (
    /APIG\.0(?:301|307|602)|security token has expired|verify ak sk signature fail/i.test(
      diagnosis,
    )
  )
    status = 401
  else if (/TM\.00001041|4291|8111\d|(^|\.)429(\.|$)/.test(code)) status = 429
  else if (
    (!response || response.ok)
    && /(^|\.)40[0-4](\.|$)|InferHub\.400[0-9]\./.test(code)
  )
    status = 400
  else if (status < 400) status = 502
  const headers = new Headers()
  const retry = response?.headers.get("retry-after")
  if (retry) headers.set("retry-after", retry)
  const body = JSON.stringify({ error: { code, message } })
  return new HTTPError(message, new Response(null, { status, headers }), body)
}

function embeddedError(event: CopilotStreamEvent): HTTPError | null {
  const raw = parse(event.data)
  if (
    raw
    && (raw.error
      || raw.error_code
      || (!raw.choices && raw.code && raw.message))
  )
    return codeArtsError(event.data ?? "")
  return null
}

function restoreNames(
  chunk: ChatCompletionChunk,
  names: Map<string, string>,
  partial: Map<string, string>,
): boolean {
  let changed = false
  for (const choice of chunk.choices ?? []) {
    for (const call of choice.delta?.tool_calls ?? []) {
      if (!call.function?.name) continue
      const fragment = call.function.name
      const id = `${choice.index}:${call.index}`
      const previous = partial.get(id)
      if (previous === "") {
        delete call.function.name // Some gateways repeat it in each delta.
        changed = true
        continue
      }
      const accumulated = `${previous ?? ""}${fragment}`
      const original = names.get(fragment) ?? names.get(accumulated)
      if (original) {
        call.function.name = original
        partial.set(id, "")
        changed = true
      } else if (
        [...names.keys()].some((short) => short.startsWith(accumulated))
      ) {
        delete call.function.name
        partial.set(id, accumulated)
        changed = true
      } else if (previous) {
        call.function.name = accumulated
        partial.delete(id)
        changed = true
      }
    }
  }
  return changed
}

/** Peek past role/keepalive chunks so a gateway error can still trigger failover. */
export async function openCodeArtsStream(
  response: Response,
  names: Map<string, string>,
): Promise<AsyncIterable<CopilotStreamEvent>> {
  if (response.headers.get("content-type")?.includes("application/json"))
    throw codeArtsError(await response.text(), response)
  const source = await safeSseStream(response, embeddedError)
  const iterator = source[Symbol.asyncIterator]()
  const head: Array<CopilotStreamEvent> = []
  let ended = false
  for (let count = 0; count < 16; count++) {
    const result = await iterator.next()
    if (result.done) {
      ended = true
      break
    }
    const error = embeddedError(result.value)
    if (error) throw error
    head.push(result.value)
    const chunk = parse(result.value.data) as ChatCompletionChunk | undefined
    if (
      result.value.data === "[DONE]"
      || chunk?.choices?.some(
        (choice) =>
          choice.finish_reason
          || choice.delta?.content
          || choice.delta?.tool_calls?.length
          || (choice.delta && extractReasoningTextAlias(choice.delta)),
      )
    )
      break
  }
  if (!head.length) throw codeArtsError("")

  async function* wire() {
    yield* head
    if (!ended) yield* { [Symbol.asyncIterator]: () => iterator }
  }
  return (async function* () {
    const partial = new Map<string, string>()
    for await (const frame of wire()) {
      const error = embeddedError(frame)
      if (error) throw error
      const chunk =
        names.size ?
          (parse(frame.data) as ChatCompletionChunk | undefined)
        : undefined
      yield chunk && restoreNames(chunk, names, partial) ?
        { ...frame, data: JSON.stringify(chunk) }
      : frame
      if (frame.data === "[DONE]") break
    }
  })()
}
