export interface SSEStream {
  writeSSE(message: { event?: string; data: string }): Promise<void>
  write?(input: string | Uint8Array): Promise<unknown>
}

export interface SSEEventLike {
  data?: string
  event?: string
}

const DEFAULT_PING_INTERVAL_MS = 5_000

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
): Promise<void> {
  await stream.writeSSE({
    ...(event ? { event } : {}),
    data,
  })
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
