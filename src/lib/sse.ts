import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { logger } from "~/lib/logger"
import {
  markPerformanceWrite,
  markPerformanceText,
  addPerformanceTiming,
  hasRequestPerformance,
  observePerformanceData,
} from "~/lib/request-performance"
import { isAbortError } from "~/lib/utils"

export interface SSEStream {
  writeSSE(message: { event?: string; data: string }): Promise<void>
  write?(input: string | Uint8Array): Promise<unknown>
}

interface SSEEventLike {
  data?: string
  event?: string
}

const DEFAULT_PING_INTERVAL_MS = 5_000
const performanceStreams = new WeakMap<SSEStream, Context>()

export function attachPerformanceStream(stream: SSEStream, c: Context): void {
  performanceStreams.set(stream, c)
}

/**
 * Sends SSE comment as keep-alive signal.
 * SSE spec defines comment lines starting with `:` which clients ignore.
 * This is the standard way to prevent idle connection timeouts.
 */
export function createSsePingInterval(
  stream: SSEStream,
  intervalMs = DEFAULT_PING_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      // SSE comment format: `: comment\n\n`
      // This is the standard SSE keep-alive mechanism
      if (stream.write) {
        await stream.write(": keep-alive\n\n")
      }
    } catch {
      // Stream already closed; the caller clears the interval in finally.
    }
  }, intervalMs)
}

export async function writeSseEvent(
  stream: SSEStream,
  data: string,
  event?: string,
  parsed?: unknown,
): Promise<void> {
  const context = performanceStreams.get(stream)
  if (context) {
    if (parsed !== undefined) markPerformanceText(context, parsed)
    else observePerformanceData(context, data)
  }
  const started = hasRequestPerformance(context) ? performance.now() : undefined
  try {
    await stream.writeSSE({
      ...(event ? { event } : {}),
      data,
    })
  } finally {
    if (started !== undefined)
      addPerformanceTiming(
        context,
        "downstreamWriteMs",
        performance.now() - started,
      )
  }
  if (context) markPerformanceWrite(context)
}

export async function writeSseComment(
  stream: SSEStream,
  comment = "connected",
): Promise<void> {
  if (!stream.write) return
  const safeComment = comment.replaceAll(/[\r\n]/g, " ")
  await stream.write(`: ${safeComment}\n\n`)
}

function formatSseFrame(data: string, event?: string): string {
  const eventLine = event ? `event: ${event}\n` : ""
  return `${eventLine}data: ${data}\n\n`
}

export async function writeSseEvents(
  stream: SSEStream,
  events: Array<{ data: string; event?: string }>,
): Promise<void> {
  if (events.length === 0) {
    return
  }

  if (events.length === 1) {
    await writeSseEvent(stream, events[0].data, events[0].event)
    return
  }

  if (stream.write) {
    const context = performanceStreams.get(stream)
    if (context)
      for (const item of events) observePerformanceData(context, item.data)
    const batch = events
      .map((item) => formatSseFrame(item.data, item.event))
      .join("")
    const started =
      hasRequestPerformance(context) ? performance.now() : undefined
    try {
      await stream.write(batch)
    } finally {
      if (started !== undefined)
        addPerformanceTiming(
          context,
          "downstreamWriteMs",
          performance.now() - started,
        )
    }
    if (context) markPerformanceWrite(context)
    return
  }

  for (const item of events) {
    await writeSseEvent(stream, item.data, item.event)
  }
}

export async function forwardSseEvent(
  stream: SSEStream,
  event: SSEEventLike,
): Promise<void> {
  if (!event.data) {
    return
  }

  await writeSseEvent(stream, event.data, event.event)
}

export function handleSseStream(
  c: Context,
  run: (stream: SSEStream, signal: AbortSignal) => Promise<void>,
  options?: {
    onAbort?: () => void
    onFinally?: () => void
    skipPing?: boolean
    initialComment?: string | false
  },
) {
  return streamSSE(c, async (stream) => {
    attachPerformanceStream(stream, c)
    const pingInterval =
      options?.skipPing ? undefined : createSsePingInterval(stream)
    const signal = c.req.raw.signal

    try {
      if (options?.initialComment !== false) {
        await writeSseComment(
          stream,
          typeof options?.initialComment === "string" ?
            options.initialComment
          : "connected",
        )
      }
      await run(stream, signal)
    } catch (error) {
      if (isAbortError(error)) {
        logger.debug("Stream aborted (client disconnected)")
        options?.onAbort?.()
        return
      }
      throw error
    } finally {
      if (pingInterval) clearInterval(pingInterval)
      options?.onFinally?.()
    }
  })
}
