import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"

import {
  normalizeUpstreamWsEvent,
  type UpstreamWsProvider,
} from "./upstream-ws-body"
import {
  extractWsErrorMessage,
  extractWsErrorStatus,
} from "./upstream-ws-error"

export const UPSTREAM_WS_STREAM_IDLE_TIMEOUT_MS = 120_000
const MAX_UPSTREAM_WS_QUEUE_MESSAGES = 1_024
const MAX_UPSTREAM_WS_QUEUE_BYTES = 16 * 1024 * 1024

export interface UpstreamWsSession {
  key: string
  provider: UpstreamWsProvider
  executionSessionId: string
  url: string
  accountId: string
  ws: WebSocket | null
  /** Serialize dial + turns on one connection key (CPA reqMu). */
  chain: Promise<void>
  closed: boolean
  lastUsedAt: number
  /** Wall-clock ms when the live socket was opened (0 until connected). */
  openedAt: number
}

export const sessions = new Map<string, UpstreamWsSession>()

export interface TurnConsumer {
  /**
   * Resolve once the first upstream event is queued (or a terminal/error/close
   * arrives). Reject if none arrives within `timeoutMs`. Does not consume the
   * queue — `iterate()` yields the buffered event(s).
   */
  waitForFirstEvent: (timeoutMs: number) => Promise<void>
  iterate: () => AsyncIterable<CopilotStreamEventLike>
  /** Tear down before streaming starts (first-event gate failed). */
  dispose: () => void
}

export function createTurnConsumer(options: {
  provider: UpstreamWsProvider
  accountId: string
  executionSessionId: string
  key: string
  sess: UpstreamWsSession
  ws: WebSocket
  signal?: AbortSignal
  releaseChain: () => void
}): TurnConsumer {
  const {
    provider,
    accountId,
    executionSessionId,
    key,
    sess,
    ws,
    signal,
    releaseChain,
  } = options

  const queue: Array<string> = []
  let queueBytes = 0
  let wake: (() => void) | undefined
  let fail: ((err: Error) => void) | undefined
  let done = false
  let terminalError: Error | undefined
  let listenersRemoved = false
  let chainReleased = false
  let socketErrored = false

  // Read through a getter so eslint/TS control-flow analysis does not narrow
  // `terminalError` to `undefined` (it is only assigned inside the listener
  // closures below, which the analyzer cannot see as reachable from here).
  const currentTerminalError = (): Error | undefined => terminalError

  const notify = () => {
    wake?.()
    wake = undefined
  }

  const rejectWait = (err: Error) => {
    terminalError = err
    done = true
    queue.length = 0
    queueBytes = 0
    fail?.(err)
    fail = undefined
    wake = undefined
  }

  const onMessage = (event: MessageEvent) => {
    let data = ""
    if (typeof event.data === "string") {
      data = event.data
    } else if (event.data instanceof ArrayBuffer) {
      if (event.data.byteLength > MAX_UPSTREAM_WS_QUEUE_BYTES) {
        rejectWait(
          new Error(
            `${provider} websockets: upstream event exceeds size limit`,
          ),
        )
        try {
          ws.close()
        } catch {
          // ignore
        }
        return
      }
      data = new TextDecoder().decode(event.data)
    }
    if (!data) return
    const dataBytes = Buffer.byteLength(data)
    if (
      queue.length >= MAX_UPSTREAM_WS_QUEUE_MESSAGES
      || queueBytes + dataBytes > MAX_UPSTREAM_WS_QUEUE_BYTES
    ) {
      rejectWait(
        new Error(
          `${provider} websockets: upstream event queue exceeds size limit`,
        ),
      )
      try {
        ws.close()
      } catch {
        // ignore
      }
      return
    }
    queue.push(data)
    queueBytes += dataBytes
    notify()
  }
  const onError = () => {
    socketErrored = true
    rejectWait(new Error(`${provider} websockets: upstream socket error`))
    notify()
  }
  const onClose = (event: CloseEvent) => {
    sess.closed = true
    if (sessions.get(key) === sess) {
      sessions.delete(key)
    }
    if (!done || socketErrored) {
      const socketAgeMs = sess.openedAt ? Date.now() - sess.openedAt : 0
      const closeCode = Number.isFinite(event.code) ? event.code : 1006
      const rawReason = typeof event.reason === "string" ? event.reason : ""
      const reason = rawReason.trim().replaceAll(/\s+/g, " ").slice(0, 200)
      logger.warn(
        `${provider} websockets: upstream socket closed unexpectedly `
          + `session=${executionSessionId} auth=${accountId} code=${closeCode} `
          + `reason=${reason || "(none)"} was_clean=${event.wasClean} `
          + `socket_age_ms=${socketAgeMs} queue_messages=${queue.length} `
          + `queue_bytes=${queueBytes}`,
      )
    }
    if (!done) {
      rejectWait(
        new Error(
          `${provider} websockets: upstream socket closed unexpectedly`,
        ),
      )
    }
    notify()
  }
  const onAbort = () => {
    rejectWait(new Error(`${provider} websockets: aborted`))
    notify()
  }

  signal?.addEventListener("abort", onAbort, { once: true })
  ws.addEventListener("message", onMessage)
  ws.addEventListener("error", onError)
  ws.addEventListener("close", onClose)

  const removeListeners = () => {
    if (listenersRemoved) return
    listenersRemoved = true
    signal?.removeEventListener("abort", onAbort)
    ws.removeEventListener("message", onMessage)
    ws.removeEventListener("error", onError)
    ws.removeEventListener("close", onClose)
  }

  const release = () => {
    if (chainReleased) return
    chainReleased = true
    releaseChain()
  }

  // Peek the first buffered frame; if it is an upstream error/response.failed
  // frame, throw it *before* the stream iterable is returned so the caller
  // (openUpstream) surfaces it eagerly — enabling provider-layer HTTP fallback
  // (connection scope) or handler account rotation (credential scope) without
  // ever forwarding a partial stream.
  const peekFirstEventError = () => {
    if (queue.length === 0) return
    const raw = queue[0]
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const eventType = typeof parsed.type === "string" ? parsed.type : ""
    if (eventType === "error" || eventType === "response.failed") {
      const removed = queue.shift()
      if (removed) queueBytes -= Buffer.byteLength(removed)
      const message = extractWsErrorMessage(parsed)
      const status = extractWsErrorStatus(parsed)
      throw new HTTPError(
        `${provider} websockets: ${message}`,
        new Response(raw, { status }),
        raw,
      )
    }
  }

  const waitForFirstEvent = async (timeoutMs: number): Promise<void> => {
    if (terminalError) throw terminalError
    if (queue.length > 0 || done) {
      peekFirstEventError()
      return
    }
    if (signal?.aborted) {
      throw new Error(`${provider} websockets: aborted`)
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        wake = undefined
        fail = undefined
        reject(
          new Error(
            `${provider} websockets: no upstream response within `
              + `${Math.round(timeoutMs / 1000)}s (timeout)`,
          ),
        )
      }, timeoutMs)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
      fail = (err) => {
        clearTimeout(timer)
        reject(err)
      }
    })
    peekFirstEventError()
  }

  async function* iterate(): AsyncIterable<CopilotStreamEventLike> {
    try {
      const pendingBeforeStream = currentTerminalError()
      if (pendingBeforeStream) throw pendingBeforeStream
      while (!done) {
        const pending = currentTerminalError()
        if (pending) throw pending
        if (signal?.aborted) {
          throw new Error(`${provider} websockets: aborted`)
        }

        if (queue.length === 0) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              wake = undefined
              fail = undefined
              reject(
                new Error(
                  `${provider} websockets: upstream stream idle timeout`,
                ),
              )
            }, UPSTREAM_WS_STREAM_IDLE_TIMEOUT_MS)
            wake = () => {
              clearTimeout(timer)
              resolve()
            }
            fail = (err) => {
              clearTimeout(timer)
              reject(err)
            }
          })
          continue
        }

        let raw = queue.shift()
        if (raw === undefined) continue
        queueBytes -= Buffer.byteLength(raw)

        let parsed: Record<string, unknown> | undefined
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>
        } catch {
          // Non-JSON frame cannot be an error/terminal event; forward as-is.
          yield { data: raw }
          continue
        }

        const originalEventType =
          typeof parsed.type === "string" ? parsed.type : ""
        const eventType = normalizeUpstreamWsEvent(parsed, provider)
        if (eventType !== originalEventType) {
          raw = JSON.stringify(parsed)
        }
        // Classify + throw the upstream error frame BEFORE forwarding it, so
        // (a) the raw error frame is never yielded to the client, (b) there is
        // no double-error, and (c) this generator's own cleanup (destroy the
        // stale session, below) runs. Providers/handler classify the thrown
        // HTTPError via classifyWsFailure.
        if (eventType === "error" || eventType === "response.failed") {
          const message = extractWsErrorMessage(parsed)
          const status = extractWsErrorStatus(parsed)
          throw new HTTPError(
            `${provider} websockets: ${message}`,
            new Response(raw, { status }),
            raw,
          )
        }

        yield { data: raw }

        // Terminal success events (Responses streaming). incomplete must not hang.
        if (
          eventType === "response.completed"
          || eventType === "response.incomplete"
        ) {
          done = true
          sess.lastUsedAt = Date.now()
          logger.info(
            `${provider} websockets: upstream terminal response session=${executionSessionId} `
              + `auth=${accountId} event=${eventType} `
              + `response_id=${readResponseId(parsed)}`,
          )
          break
        }
      }

      yield { data: "[DONE]" }
    } catch (error) {
      // Drop broken connections so the next turn dials fresh.
      try {
        ws.close()
      } catch {
        // ignore
      }
      sess.closed = true
      if (sessions.get(key) === sess) {
        sessions.delete(key)
      }
      throw error
    } finally {
      removeListeners()
      release()
    }
  }

  const dispose = () => {
    removeListeners()
    try {
      ws.close()
    } catch {
      // ignore
    }
    sess.closed = true
    if (sessions.get(key) === sess) {
      sessions.delete(key)
    }
    release()
  }

  return { waitForFirstEvent, iterate, dispose }
}

function readResponseId(parsed: Record<string, unknown>): string {
  const response = parsed.response
  if (response && typeof response === "object") {
    const id = (response as { id?: unknown }).id
    if (typeof id === "string") return id
  }
  return ""
}
