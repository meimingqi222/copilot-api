import { delay } from "~/lib/delay"
import {
  type QoderQueue,
  QoderUpstreamError,
  readQoderQueue,
} from "~/services/qoder/errors"

interface QueueOptions {
  error: QoderUpstreamError
  status(signal: AbortSignal): Promise<Response>
  signal?: AbortSignal
  deadline: number
}

/** A queue slot belongs to the original request set, not a new task. */
export async function waitForQoderQueue(options: QueueOptions): Promise<void> {
  let queue: QoderQueue = options.error.queue ?? {}
  let failures = 0
  let previous = ""
  let unchangedAt = Date.now()
  let asked = false
  while (Date.now() < options.deadline) {
    options.signal?.throwIfAborted()
    if (asked) {
      const ms = Math.min(
        30_000,
        Math.max(500, (queue.retryAfterSeconds ?? 30) * 1000),
      )
      await delay(
        Math.min(ms, Math.max(0, options.deadline - Date.now())),
        options.signal,
      )
    }
    asked = true
    const left = Math.min(30_000, options.deadline - Date.now())
    if (left <= 0) break
    const timeout = AbortSignal.timeout(left)
    let response: Response
    try {
      response = await options.status(
        options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      )
      if (response.status === 404) {
        await response.body?.cancel()
        break
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error("Qoder queue status failed")
      }
      const state = readQoderQueue(await response.text())
      if (!state) break
      queue = { ...queue, ...state }
      failures = 0
    } catch {
      options.signal?.throwIfAborted()
      if (++failures >= 3) throw options.error
      continue
    }
    if (queue.isQueued === false && queue.serviceAvailable !== false) {
      const pause = Math.min(
        30_000,
        Math.max(0, (queue.retryAfterSeconds ?? 0) * 1000),
      )
      if (Date.now() + pause >= options.deadline) break
      await delay(pause, options.signal)
      return
    }
    const key = (queue.queueCount ?? 1) <= 1 ? JSON.stringify(queue) : ""
    if (!key || key !== previous) unchangedAt = Date.now()
    previous = key
    if (key && Date.now() - unchangedAt >= 5 * 60_000) {
      options.error.message +=
        " (the queue has not moved in 5 minutes with nothing ahead)"
      throw options.error
    }
  }
  throw options.error
}
