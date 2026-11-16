import { HTTPError } from "~/lib/error"
import type { CopilotStreamEvent } from "~/services/protocols/chat/types"
import { QoderUpstreamError } from "~/services/qoder/errors"
import { waitForQoderQueue } from "~/services/qoder/queue"

export class QoderNamelessToolError extends HTTPError {
  constructor() {
    super(
      "Qoder returned a tool call without a function name",
      new Response(null, { status: 502 }),
    )
  }
}

interface RequestOptions {
  key: string
  model: string
  streaming: boolean
  signal?: AbortSignal
  hasFallback?: () => boolean
  open(
    signal: AbortSignal,
    cap?: number,
  ): Promise<AsyncIterable<CopilotStreamEvent>>
  queueStatus(error: QoderUpstreamError, signal: AbortSignal): Promise<Response>
  recover?(): Promise<boolean>
}

const outputCaps = new Map<string, number>()

/** Retry only refusals received before output, never replay a partially delivered turn. */
export async function openQoderRequest(
  options: RequestOptions,
): Promise<AsyncIterable<CopilotStreamEvent>> {
  const controller = new AbortController()
  const signal =
    options.signal ?
      AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const began = Date.now()
  let recovered = false
  let renamed = false
  let clamped = false
  let queued = 0
  let held = false
  const attempt = async (): Promise<AsyncIterable<CopilotStreamEvent>> => {
    signal.throwIfAborted()
    try {
      return await options.open(signal, outputCaps.get(options.key))
    } catch (error) {
      if (error instanceof QoderNamelessToolError && !renamed) {
        renamed = true
        return attempt()
      }
      if (!(error instanceof QoderUpstreamError)) throw error
      if (error.lapsed && !recovered && options.recover) {
        recovered = true
        if (await options.recover()) return attempt()
      }
      if (error.maxTokens && error.maxTokens > 0 && !clamped) {
        clamped = true
        outputCaps.delete(options.key)
        outputCaps.set(options.key, error.maxTokens)
        while (outputCaps.size > 512)
          outputCaps.delete(outputCaps.keys().next().value!)
        return attempt()
      }
      if (!error.queue || queued++ >= 10 || options.hasFallback?.()) throw error
      if (options.streaming && !held) throw error
      await waitForQoderQueue({
        error,
        signal,
        deadline: began + (options.streaming ? 60 * 60_000 : 4 * 60_000),
        status: (s) => options.queueStatus(error, s),
      })
      return attempt()
    }
  }
  let source: AsyncIterable<CopilotStreamEvent>
  try {
    source = await attempt()
  } catch (error) {
    if (
      !(error instanceof QoderUpstreamError)
      || !error.queue
      || !options.streaming
      || options.hasFallback?.()
    ) {
      controller.abort()
      throw error
    }
    held = true
    // Keep the same task and queue lease; do not resend until its status clears.
    const pending = waitForQoderQueue({
      error,
      signal,
      deadline: began + 60 * 60_000,
      status: (s) => options.queueStatus(error, s),
    }).then(attempt)
    const ready = pending.then(
      (source) => ({ source, error: undefined }),
      (error: unknown) => ({ source: undefined, error }),
    )
    source = keepQueueAlive(ready, options.model)
  }
  return (async function* () {
    try {
      yield* source
    } finally {
      controller.abort()
    }
  })()
}

async function* keepQueueAlive(
  ready: Promise<{
    source: AsyncIterable<CopilotStreamEvent> | undefined
    error: unknown
  }>,
  model: string,
): AsyncGenerator<CopilotStreamEvent> {
  const id = `chatcmpl-${crypto.randomUUID()}`
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        ready,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), 10_000)
        }),
      ])
      if (result) {
        if (result.error) throw result.error
        if (result.source) {
          for await (const frame of result.source) {
            if (frame.data && frame.data !== "[DONE]") {
              const chunk = JSON.parse(frame.data) as Record<string, unknown>
              yield { ...frame, data: JSON.stringify({ ...chunk, id }) }
            } else yield frame
          }
        }
        return
      }
      // A valid empty Chat chunk survives Chat forwarding without becoming prose.
      yield {
        event: "ping",
        data: JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
        }),
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
