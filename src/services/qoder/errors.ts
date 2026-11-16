import { HTTPError } from "~/lib/error"
import { asRecord } from "~/lib/json-shape"

export interface QoderQueue {
  isQueued?: boolean
  serviceAvailable?: boolean
  retryAfterSeconds?: number
  queueCount?: number
  modelKey?: string
  queueType?: string
  subCode?: string
}

function json(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return asRecord(value)
  try {
    return asRecord(JSON.parse(value.trim()))
  } catch {
    return undefined
  }
}

export function readQoderQueue(value: unknown): QoderQueue | undefined {
  const pending = [value]
  for (let n = 0; pending.length && n < 32; n++) {
    const obj = json(pending.shift())
    if (!obj) continue
    if ("isQueued" in obj || "serviceAvailable" in obj) {
      const flag = (v: unknown) =>
        v === true || v === "true" ? true
        : v === false || v === "false" ? false
        : undefined
      const num = (v: unknown) =>
        v !== null && v !== "" && Number.isFinite(Number(v)) ?
          Number(v)
        : undefined
      return {
        isQueued: flag(obj.isQueued),
        serviceAvailable: flag(obj.serviceAvailable),
        retryAfterSeconds: num(obj.retryAfterSeconds),
        queueCount: num(obj.queueCount),
        modelKey: typeof obj.modelKey === "string" ? obj.modelKey : undefined,
        queueType:
          typeof obj.queueType === "string" ? obj.queueType : undefined,
        subCode: typeof obj.subCode === "string" ? obj.subCode : undefined,
      }
    }
    pending.push(obj.data, obj.result, obj.message, obj.body, obj.queue)
  }
  return undefined
}

export class QoderUpstreamError extends HTTPError {
  queue?: QoderQueue
  maxTokens?: number
  lapsed = false
}

/** Business codes take precedence over HTTP status: a queue can arrive as 403. */
export function qoderError(status: number, body: string): QoderUpstreamError {
  let parsed = json(body)
  const outerCode = String(parsed?.code ?? "")
  const wrapped = json(parsed?.message)
  if (
    ["", "401", "403"].includes(outerCode)
    && String(wrapped?.code) === "10605"
  )
    parsed = wrapped
  const code = String(parsed?.code ?? "")
  const nested = asRecord(parsed?.error)
  let message = String(
    parsed?.message
      || nested?.message
      || body.trim().slice(0, 500)
      || `Qoder upstream error ${status}`,
  )
  const detail = asRecord(json(parsed?.details)?.error)?.message
  if (typeof detail === "string" && !message.includes(detail))
    message += `: ${detail}`
  const queue = readQoderQueue(parsed)
  const queued =
    code === "10605"
    || queue?.isQueued === true
    || queue?.serviceAvailable === false
  const range = /Range of max_tokens should be \[1,\s*(\d+)\]/i.exec(message)
  const headers = new Headers()
  let lapsed = false
  if (queued) {
    status = 503
    headers.set(
      "Retry-After",
      String(Math.max(1, Math.ceil(queue?.retryAfterSeconds || 30))),
    )
    message = `Qoder queued the request${queue?.modelKey ? ` for ${queue.modelKey}` : ""}${queue?.queueCount !== undefined ? ` (${queue.queueCount} in queue)` : ""}: ${message}`
  } else if (
    [
      "110",
      "112",
      "113",
      "114",
      "115",
      "116",
      "117",
      "118",
      "119",
      "122",
    ].includes(code)
  ) {
    status = 429
    message = `usage limit reached: ${message}`
  } else if (
    [
      "406",
      "416",
      "430",
      "80411",
      "80412",
      "100400",
      "100401",
      "100402",
      "100403",
    ].includes(code)
    || range
  ) {
    status = 400
  } else if (/error in upstream response/i.test(message)) {
    status = 502
  } else if (code === "105" || status === 401 || status === 403) {
    status = 401
    lapsed = true
    message = `Qoder: the sign-in lapsed — sign in again (${message})`
  } else if (status === 429 || /quota/i.test(message)) {
    status = 429
    message = `usage limit reached: ${message}`
  }
  if (status < 400 || status > 599) status = 502
  // Keep the classified message in the body too; dispatch classifies that body.
  const error = new QoderUpstreamError(
    message,
    new Response(null, { status, headers }),
    JSON.stringify({
      error: { message, code: queued ? "qoder_queue" : code || status },
    }),
  )
  error.queue = queued ? (queue ?? {}) : undefined
  error.maxTokens = range ? Number(range[1]) : undefined
  error.lapsed = lapsed
  return error
}
