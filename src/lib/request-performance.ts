import type { Context } from "hono"

import { getSystemSettings } from "~/lib/system-config"

export interface RequestPerformance {
  version: 1
  endpoint: string
  transport: "http" | "ws"
  translated: boolean
  requestBodyBytes?: number
  generationMs?: number
  outputTtftMs?: number
  textTtftMs?: number
  firstWriteMs?: number
  preprocessingMs?: number
  bodyParseMs?: number
  bodyReadMs?: number
  jsonDecodeMs?: number
  admissionMs?: number
  routingDecisionMs?: number
  tokenEstimateMs?: number
  dispatchToOutputMs?: number
  requestTranslationMs?: number
  firstTranslatedFrameMs?: number
  rateLimitWaitMs?: number
  failedAttemptMs?: number
  upstreamHeadersMs?: number
  upstreamConnectMs?: number
  upstreamQueueMs?: number
  upstreamFirstEventMs?: number
  upstreamBodyReadMs?: number
  adapterPreparationMs?: number
  responseTranslationMs?: number
  streamTranslationActiveMs?: number
  downstreamWriteMs?: number
  outputToWriteMs?: number
  upstreamToOutputMs?: number
  responseReadyMs?: number
}

interface PerformanceState {
  requestBodyBytes?: number
  start: number
  dispatch?: number
  output?: number
  text?: number
  write?: number
  requestTranslationMs?: number
  firstTranslatedFrameMs?: number
  translated: boolean
  timings: Partial<Record<PerformanceTiming, number>>
  upstreamSent?: number
  upstreamEvent?: number
  outputWrite?: number
  responseReady?: number
}

export type PerformanceTiming =
  | "bodyParseMs"
  | "bodyReadMs"
  | "jsonDecodeMs"
  | "admissionMs"
  | "routingDecisionMs"
  | "tokenEstimateMs"
  | "upstreamConnectMs"
  | "upstreamQueueMs"
  | "rateLimitWaitMs"
  | "failedAttemptMs"
  | "upstreamHeadersMs"
  | "upstreamFirstEventMs"
  | "upstreamBodyReadMs"
  | "adapterPreparationMs"
  | "responseTranslationMs"
  | "streamTranslationActiveMs"
  | "downstreamWriteMs"

const requests = new WeakMap<Context, PerformanceState>()

export function startRequestPerformance(
  c: Context,
  now = performance.now(),
): void {
  if (!getSystemSettings().performanceDetails) {
    requests.delete(c)
    return
  }
  requests.set(c, { start: now, translated: false, timings: {} })
}

export function hasRequestPerformance(c: Context | undefined): boolean {
  return Boolean(c && requests.has(c))
}

export function recordRequestBodyBytes(
  c: Context | undefined,
  bytes: number,
): void {
  const state = c && requests.get(c)
  if (state) state.requestBodyBytes = bytes
}

export function markResponseReady(
  c: Context | undefined,
  now = performance.now(),
): void {
  const state = c && requests.get(c)
  if (state) state.responseReady = now
}

export function addPerformanceTiming(
  c: Context | undefined,
  field: PerformanceTiming,
  ms: number,
): void {
  const state = c && requests.get(c)
  if (!state || !Number.isFinite(ms) || ms < 0) return
  state.timings[field] = (state.timings[field] ?? 0) + ms
}

export async function measurePerformanceStage<T>(
  c: Context | undefined,
  field: PerformanceTiming,
  run: () => T | Promise<T>,
): Promise<T> {
  if (!hasRequestPerformance(c)) return run()
  const started = performance.now()
  try {
    return await run()
  } finally {
    addPerformanceTiming(c, field, performance.now() - started)
  }
}

export function markUpstreamSent(
  c: Context | undefined,
  now = performance.now(),
): void {
  const state = c && requests.get(c)
  if (!state) return
  state.upstreamSent = now
  state.upstreamEvent = undefined
  delete state.timings.upstreamFirstEventMs
}

export function markUpstreamEvent(
  c: Context | undefined,
  sentAt?: number,
  now = performance.now(),
): void {
  const state = c && requests.get(c)
  if (!state || state.upstreamEvent !== undefined) return
  const sent = sentAt ?? state.upstreamSent
  if (sent === undefined) return
  if (state.upstreamSent !== undefined && sent !== state.upstreamSent) return
  state.upstreamEvent = now
  state.timings.upstreamFirstEventMs = Math.max(0, now - sent)
}

export function markPerformanceDispatch(
  c: Context,
  now = performance.now(),
): void {
  const state = requests.get(c)
  if (state && state.dispatch === undefined) state.dispatch = now
}

export function markPerformanceOutput(
  c: Context,
  now = performance.now(),
): void {
  const state = requests.get(c)
  if (state && state.output === undefined) state.output = now
}

export function markPerformanceWrite(
  c: Context,
  now = performance.now(),
): void {
  const state = requests.get(c)
  if (state && state.write === undefined) state.write = now
  if (state && state.output !== undefined && state.outputWrite === undefined)
    state.outputWrite = now
}

export function markPerformanceText(c: Context, frame: unknown): void {
  const state = requests.get(c)
  if (state && state.text === undefined && hasVisibleText(frame)) {
    state.text = performance.now()
  }
}

export function observePerformanceData(c: Context, data: string): void {
  const state = requests.get(c)
  if (!state || state.text !== undefined || data === "[DONE]") return
  try {
    markPerformanceText(c, JSON.parse(data) as unknown)
  } catch {
    return
  }
}

export function addRequestTranslationTime(
  c: Context | undefined,
  ms: number,
): void {
  const state = c && requests.get(c)
  if (!state) return
  state.translated = true
  state.requestTranslationMs = (state.requestTranslationMs ?? 0) + ms
}

function markFirstTranslatedFrame(c: Context | undefined, ms: number): void {
  const state = c && requests.get(c)
  if (state && state.firstTranslatedFrameMs === undefined) {
    state.firstTranslatedFrameMs = ms
  }
}

export async function* measureTranslatedStream<Input, Output>(
  input: AsyncIterable<Input>,
  translate: (source: AsyncIterable<Input>) => AsyncIterable<Output>,
  c: Context | undefined,
): AsyncGenerator<Output> {
  if (!c || !requests.has(c)) {
    yield* translate(input)
    return
  }
  let firstInputAt: number | undefined
  let measured = false
  let inputWaitMs = 0
  async function* observeInput(): AsyncGenerator<Input> {
    const iterator = input[Symbol.asyncIterator]()
    try {
      while (true) {
        const started = performance.now()
        const next = await iterator.next()
        inputWaitMs += performance.now() - started
        if (next.done) return
        firstInputAt ??= performance.now()
        yield next.value
      }
    } finally {
      await iterator.return?.()
    }
  }
  const iterator = translate(observeInput())[Symbol.asyncIterator]()
  try {
    while (true) {
      const started = performance.now()
      const beforeWait = inputWaitMs
      const next = await iterator.next()
      addPerformanceTiming(
        c,
        "streamTranslationActiveMs",
        Math.max(0, performance.now() - started - (inputWaitMs - beforeWait)),
      )
      if (next.done) return
      const frame = next.value
      if (!measured && firstInputAt !== undefined) {
        markFirstTranslatedFrame(c, performance.now() - firstInputAt)
        measured = true
      }
      yield frame
    }
  } finally {
    await iterator.return?.()
  }
}

export function requestPerformanceSnapshot(
  c: Context,
  streaming: boolean | undefined,
  now = performance.now(),
): RequestPerformance | undefined {
  const state = requests.get(c)
  if (!state) return undefined
  const elapsed = (timestamp: number | undefined) =>
    timestamp === undefined ? undefined : Math.max(0, timestamp - state.start)
  return {
    version: 1,
    endpoint: c.req.path,
    transport: c.req.method === "GET" ? "ws" : "http",
    translated: state.translated,
    requestBodyBytes: state.requestBodyBytes,
    ...state.timings,
    responseReadyMs:
      state.responseReady === undefined ?
        undefined
      : Math.max(0, state.responseReady - state.start),
    outputToWriteMs:
      state.outputWrite !== undefined && state.output !== undefined ?
        Math.max(0, state.outputWrite - state.output)
      : undefined,
    upstreamToOutputMs:
      state.upstreamEvent !== undefined && state.output !== undefined ?
        Math.max(0, state.output - state.upstreamEvent)
      : undefined,
    generationMs:
      streaming && state.output !== undefined && now > state.output ?
        now - state.output
      : undefined,
    outputTtftMs: elapsed(state.output),
    textTtftMs: elapsed(state.text),
    firstWriteMs: elapsed(state.write),
    preprocessingMs: elapsed(state.dispatch),
    dispatchToOutputMs:
      state.output !== undefined && state.dispatch !== undefined ?
        Math.max(0, state.output - state.dispatch)
      : undefined,
    requestTranslationMs: state.requestTranslationMs,
    firstTranslatedFrameMs: state.firstTranslatedFrameMs,
  }
}

export function hasVisibleText(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const frame = value as Record<string, unknown>
  const nonempty = (text: unknown) =>
    typeof text === "string" && text.length > 0
  if (
    frame.type === "response.output_text.delta"
    || frame.type === "response.refusal.delta"
  ) {
    return nonempty(frame.delta)
  }
  if (Array.isArray(frame.choices)) {
    return frame.choices.some((choice: unknown) => {
      if (!choice || typeof choice !== "object") return false
      const item = choice as {
        delta?: Record<string, unknown>
        message?: Record<string, unknown>
      }
      return (
        nonempty(item.delta?.content)
        || nonempty(item.delta?.refusal)
        || nonempty(item.message?.content)
        || nonempty(item.message?.refusal)
      )
    })
  }
  const block = frame.content_block as Record<string, unknown> | undefined
  const delta = frame.delta as Record<string, unknown> | undefined
  if (nonempty(block?.text) || nonempty(delta?.text)) return true
  if (nonempty(frame.output_text)) return true
  const parts = frame.output ?? frame.content
  if (Array.isArray(parts))
    return parts.some((part: unknown) => {
      if (!part || typeof part !== "object") return false
      const item = part as Record<string, unknown>
      return (
        nonempty(item.text)
        || (Array.isArray(item.content) && item.content.some(hasVisibleText))
      )
    })
  if (frame.response && typeof frame.response === "object")
    return hasVisibleText(frame.response)
  return (
      frame.type === "output_text"
        || frame.type === "text"
        || frame.type === "refusal"
    ) ?
      nonempty(frame.text) || nonempty(frame.refusal)
    : false
}
