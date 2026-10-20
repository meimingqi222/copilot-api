import type {
  GeminiGenerateContentResponse,
  GeminiPart,
} from "~/services/protocols/gemini/types"
import { parseRpcJson } from "~/services/aistudio/rpc"

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid AI Studio array")
  return value as unknown[]
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid AI Studio string")
  return value
}

function struct(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    array(array(value)[0] ?? []).map((item) => {
      const entry = array(item)
      return [text(entry[0]), decodeValue(entry[1])]
    }),
  )
}

function decodeValue(value: unknown): unknown {
  const wire = array(value)
  if (wire[0] === 0) return null
  if (wire[1] != null) return Number(wire[1])
  if (wire[2] != null) return text(wire[2])
  if (wire[3] != null) return wire[3] === true || wire[3] === 1
  if (wire[4] != null) return struct(wire[4])
  if (wire[5] != null) return array(array(wire[5])[0] ?? []).map(decodeValue)
  throw new Error("Invalid AI Studio Struct value")
}

function part(value: unknown): GeminiPart {
  const wire = array(value)
  const result: GeminiPart = {}
  if (wire[1] != null) result.text = text(wire[1])
  if (wire[2] != null) {
    const media = array(wire[2])
    result.inlineData = { mimeType: text(media[0]), data: text(media[1]) }
  }
  if (wire[6] != null) {
    const file = array(wire[6])
    result.fileData = { mimeType: text(file[0]), fileUri: text(file[1]) }
  }
  if (wire[10] != null) {
    const call = array(wire[10])
    result.functionCall = { name: text(call[0]), args: struct(call[1]) }
    if (call[2] != null) result.functionCall.id = text(call[2])
  }
  if (wire[11] != null) {
    const response = array(wire[11])
    result.functionResponse = {
      name: text(response[0]),
      response: struct(response[1]),
    }
    if (response[2] != null) result.functionResponse.id = text(response[2])
  }
  if (wire[12] != null) result.thought = wire[12] === true || wire[12] === 1
  if (wire[14] != null) result.thoughtSignature = text(wire[14])
  return result
}

const finishes = [
  "FINISH_REASON_UNSPECIFIED",
  "STOP",
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "OTHER",
  "LANGUAGE",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "IMAGE_SAFETY",
  "UNEXPECTED_TOOL_CALL",
  "TOO_MANY_TOOL_CALLS",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_OTHER",
  "NO_IMAGE",
  "IMAGE_RECITATION",
  "MISSING_THOUGHT_SIGNATURE",
]

function frame(value: unknown): GeminiGenerateContentResponse {
  const wire = array(value)
  if (wire[1] != null) throw new Error("AI Studio prompt rejected")
  const result: GeminiGenerateContentResponse = {}
  if (wire[0] != null)
    result.candidates = array(wire[0]).map((raw, index) => {
      const candidate = array(raw)
      const content = candidate[0] == null ? undefined : array(candidate[0])
      const finish = candidate[1]
      if (
        finish != null
        && (!Number.isInteger(finish) || !finishes[Number(finish)])
      )
        throw new Error("Unsupported AI Studio finish code")
      if (content && content[1] !== "model")
        throw new Error("Invalid AI Studio response role")
      return {
        index,
        content:
          content ?
            { role: "model" as const, parts: array(content[0] ?? []).map(part) }
          : undefined,
        finishReason:
          finish == null || finish === 0 ? undefined : finishes[Number(finish)],
      }
    })
  if (wire[2] != null) {
    const values = array(wire[2])
    const fields = [
      "promptTokenCount",
      "candidatesTokenCount",
      "totalTokenCount",
      "cachedContentTokenCount",
      "thoughtsTokenCount",
    ]
    const indexes = [0, 1, 2, 3, 9]
    result.usageMetadata = Object.fromEntries(
      fields.map((name, i) => [
        name,
        values.at(indexes[i]) == null ?
          undefined
        : Number(values.at(indexes[i])),
      ]),
    )
  }
  return result
}

/** Retains one frame, not the response. Envelope tail is validated separately. */
class Frames {
  depth = 0
  quoted = false
  escaped = false
  value = ""
  prefix = ""
  tail = ""
  started = false
  repeatedClosed = false
  needsComma = false

  push(char: string): unknown[] {
    if (!this.started) {
      this.prefix += char
      if (/^\s*(?:\)\]\}'\s*)?\[\s*\[$/.test(this.prefix)) {
        this.started = true
        this.depth = 2
      } else if (this.prefix.length > 64)
        throw new Error("Invalid AI Studio envelope")
      return []
    }
    if (this.repeatedClosed) {
      this.tail += char
      return []
    }
    if (this.depth === 2) {
      if (char === "]") {
        this.repeatedClosed = true
        return []
      }
      if (/\s/.test(char)) return []
      if (char === "," && this.needsComma) {
        this.needsComma = false
        return []
      }
      if (this.needsComma) throw new Error("AI Studio missing frame separator")
      if (char !== "[") throw new Error("Invalid AI Studio frame")
    }
    this.value += char
    if (this.quoted) {
      if (this.escaped) this.escaped = false
      else if (char === "\\") this.escaped = true
      else if (char === '"') this.quoted = false
    } else {
      if (char === '"') this.quoted = true
      if (char === "[") this.depth++
      if (char === "]") this.depth--
      if (this.depth === 2) {
        const value = parseRpcJson(this.value)
        this.value = ""
        this.needsComma = true
        return [value]
      }
    }
    return []
  }

  end() {
    if (!this.repeatedClosed || this.quoted || this.value)
      throw new Error("AI Studio truncated stream")
    const envelope = array(parseRpcJson(`[[]${this.tail}`))
    if (envelope[1] != null) {
      const status = array(envelope[1])
      if (status[0] != null && status[0] !== 0)
        throw new Error(`AI Studio RPC failed (code ${Number(status[0])})`)
    }
  }
}

export async function* decodeGenerateStream(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<GeminiGenerateContentResponse> {
  if (!response.ok || !response.body)
    throw new Error(`AI Studio HTTP ${response.status}`)
  const reader = response.body.getReader()
  const parser = new Frames()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let finished = false
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      const chunk = decoder.decode(value, { stream: !done })
      for (const char of chunk)
        for (const raw of parser.push(char)) {
          const event = frame(raw)
          if (event.candidates?.some((c) => c.finishReason)) finished = true
          yield event
        }
      if (done) break
    }
    parser.end()
    if (!finished) throw new Error("AI Studio missing finish")
  } finally {
    signal?.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function collectGenerateResponse(
  events: AsyncIterable<GeminiGenerateContentResponse>,
): Promise<GeminiGenerateContentResponse> {
  const result: GeminiGenerateContentResponse = { candidates: [] }
  for await (const event of events) {
    if (event.usageMetadata) result.usageMetadata = event.usageMetadata
    for (const candidate of event.candidates ?? []) {
      const index = candidate.index ?? 0
      let target = result.candidates?.find((c) => c.index === index)
      if (!target) {
        target = { index, content: { role: "model", parts: [] } }
        result.candidates?.push(target)
      }
      target.content?.parts.push(...(candidate.content?.parts ?? []))
      if (candidate.finishReason) target.finishReason = candidate.finishReason
    }
  }
  if (
    !result.candidates?.length
    || result.candidates.some((c) => !c.finishReason)
  )
    throw new Error("AI Studio missing finish")
  return result
}
