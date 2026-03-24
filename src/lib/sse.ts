export interface SSEStream {
  writeSSE(message: { event?: string; data: string }): Promise<void>
}

export interface SSEEventLike {
  data?: string
  event?: string
}

const DEFAULT_PING_INTERVAL_MS = 5_000
const DEFAULT_PING_EVENT = "ping"
const DEFAULT_PING_PAYLOAD = '{"type":"ping"}'

export function createSsePingInterval(
  stream: SSEStream,
  intervalMs = DEFAULT_PING_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      await writeSseEvent(stream, DEFAULT_PING_PAYLOAD, DEFAULT_PING_EVENT)
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
