/**
 * Mimo Native Protocol Adapter。
 *
 * Phase 2c:纯 (connection, credential) 热路径,不再经由
 * connectionToAccount 派生 Account。
 */

import { randomUUID } from "node:crypto"

import type { ChatCompletionResponse } from "~/services/protocols/chat/types"

import { HTTPError } from "~/lib/error"
import { serializeUpstreamBody } from "~/lib/upstream-performance"
import { parseModelReference } from "~/lib/route-target/model-reference"
import {
  type MimoMessage,
  type MimoConnection,
  mimoConnections,
} from "~/services/mimo/connections"
import { markAccountFailed } from "~/services/mimo/manager"
import { MAX_MIMO_RESPONSE_BYTES } from "~/services/mimo/ws-proxy"
import {
  detectAnthropicStreamError,
  detectOpenAIStreamError,
} from "~/services/protocols/shared"

import type { ProtocolAdapter } from "./types"

interface StreamChunk {
  data: string
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const IDLE_TIMEOUT_MS = (() => {
  const raw = process.env.MIMO_IDLE_TIMEOUT_MS
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ?
      parsed
    : DEFAULT_IDLE_TIMEOUT_MS
})()
const IDLE_TIMEOUT_MESSAGE = `Request timeout: No data received from Mimo node for ${Math.round(IDLE_TIMEOUT_MS / 1000)} seconds`
const MAX_MIMO_QUEUED_MESSAGES = 1024
const MAX_MIMO_QUEUE_BYTES = MAX_MIMO_RESPONSE_BYTES
const mimoBodySizeCache = new WeakMap<object, number>()

function getMimoMessageBytes(msg: MimoMessage): number {
  let bytes = 0
  if (msg.chunk) bytes += Buffer.byteLength(msg.chunk)
  if (msg.error) bytes += Buffer.byteLength(msg.error)
  if (msg.body !== undefined) {
    if (typeof msg.body === "object" && msg.body !== null) {
      const cached = mimoBodySizeCache.get(msg.body)
      if (cached !== undefined) {
        bytes += cached
      } else {
        const body = JSON.stringify(msg.body)
        const bodyBytes = body ? Buffer.byteLength(body) : 0
        mimoBodySizeCache.set(msg.body, bodyBytes)
        bytes += bodyBytes
      }
    } else {
      const body = JSON.stringify(msg.body)
      if (body) bytes += Buffer.byteLength(body)
    }
  }
  return bytes
}

async function returnAsyncIterator<T>(
  iterator: AsyncIterator<T>,
): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // Ignore cleanup failures while reporting the original stream error.
  }
}

/**
 * One Mimo request's inbound message queue.
 *
 * The bridge delivers frames asynchronously through `conn.activeRequests`,
 * so both the streaming and the non-streaming path need the same bounded
 * queue: 1024-message / 16 MiB backpressure, an idle timer that fails the
 * turn when the node goes silent, and abort wiring. Consumers differ only in
 * how each `MimoMessage` is interpreted.
 */
interface MimoMessageQueue {
  next(): Promise<MimoMessage>
  dispose(): void
}

function openMimoMessageQueue(
  conn: MimoConnection,
  reqId: string,
  signal?: AbortSignal,
): MimoMessageQueue {
  const queue: Array<MimoMessage> = []
  let queuedBytes = 0
  let resolveNext: (() => void) | null = null
  let error: Error | null = null
  let idleTimeoutId: ReturnType<typeof setTimeout> | null = null

  const wake = () => {
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  const resetIdleTimer = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    idleTimeoutId = setTimeout(() => {
      error = new Error(IDLE_TIMEOUT_MESSAGE)
      wake()
    }, IDLE_TIMEOUT_MS)
  }

  const listener = (msg: MimoMessage) => {
    if (error) return
    const messageBytes = getMimoMessageBytes(msg)
    if (
      queue.length >= MAX_MIMO_QUEUED_MESSAGES
      || queuedBytes + messageBytes > MAX_MIMO_QUEUE_BYTES
    ) {
      error = new Error("Mimo response message queue exceeds the maximum size")
      queue.length = 0
      queuedBytes = 0
      wake()
      return
    }
    queue.push(msg)
    queuedBytes += messageBytes
    resetIdleTimer()
    wake()
  }

  conn.activeRequests.set(reqId, listener)

  const onAbort = () => {
    error = new Error("Request aborted")
    wake()
  }

  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }

  resetIdleTimer()

  return {
    async next(): Promise<MimoMessage> {
      for (;;) {
        if (error) throw error

        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve
          })
        }

        if (error) throw error

        const msg = queue.shift()
        if (!msg) continue
        queuedBytes -= getMimoMessageBytes(msg)
        return msg
      }
    },
    dispose() {
      if (idleTimeoutId) clearTimeout(idleTimeoutId)
      queue.length = 0
      queuedBytes = 0
      conn.activeRequests.delete(reqId)
      if (signal) signal.removeEventListener("abort", onAbort)
    },
  }
}

async function* streamResponse(
  conn: MimoConnection,
  reqId: string,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const messages = openMimoMessageQueue(conn, reqId, signal)
  let responseBytes = 0

  try {
    for (;;) {
      const msg = await messages.next()

      if (msg.type === "stream_start") {
        // Ignore: status/headers already captured by bridge protocol.
        // Keeping this branch prevents silent discard of upstream HTTP status.
      } else if (msg.type === "response" && msg.body) {
        // Non-SSE reply arrived while expecting a stream (e.g. upstream error).
        // Yield as a single SSE data line then finish, matching mimo-claw behavior.
        const bodyStr = JSON.stringify(msg.body)
        responseBytes += Buffer.byteLength(bodyStr)
        if (responseBytes > MAX_MIMO_RESPONSE_BYTES) {
          throw new Error("Mimo response exceeds the maximum size")
        }
        yield { data: bodyStr }
        break
      } else if (msg.type === "stream_delta" && msg.chunk) {
        // Bridge.py already strips "data: " prefix, chunk is raw JSON
        responseBytes += Buffer.byteLength(msg.chunk)
        if (responseBytes > MAX_MIMO_RESPONSE_BYTES) {
          throw new Error("Mimo response exceeds the maximum size")
        }
        yield { data: msg.chunk }
      } else if (msg.type === "stream_end") {
        break
      } else if (msg.type === "error") {
        const errorMsg =
          (msg.error as string) || String(msg.body) || "Node returned an error"
        throw new Error(errorMsg)
      }
    }
    yield { data: "[DONE]" }
  } finally {
    messages.dispose()
  }
}

/**
 * Collect a non-streaming response from the Mimo bridge.
 *
 * Handles both accumulated stream deltas (parsed as one JSON document) and a
 * direct `response` frame. `T` is the wire's already-decoded body type; the
 * two callers differ only in that annotation, so the queue limits, backpressure
 * and idle timeout stay in this one copy.
 */
async function collectMimoResponse<T>(
  conn: MimoConnection,
  reqId: string,
  signal?: AbortSignal,
): Promise<T> {
  const messages = openMimoMessageQueue(conn, reqId, signal)
  const accumulatedBodyParts: Array<string> = []
  let accumulatedBytes = 0

  try {
    for (;;) {
      const msg = await messages.next()

      if (msg.type === "stream_start") {
        // Ignore: non-streaming path — status/headers not needed here.
      } else if (msg.type === "stream_delta" && msg.chunk) {
        const chunkBytes = Buffer.byteLength(msg.chunk)
        accumulatedBytes += chunkBytes
        if (accumulatedBytes > MAX_MIMO_RESPONSE_BYTES) {
          throw new Error("Mimo response exceeds the maximum size")
        }
        accumulatedBodyParts.push(msg.chunk)
      } else if (msg.type === "stream_end") {
        break
      } else if (msg.type === "response" && msg.body) {
        if (getMimoMessageBytes(msg) > MAX_MIMO_RESPONSE_BYTES) {
          throw new Error("Mimo response exceeds the maximum size")
        }
        return msg.body as T
      } else if (msg.type === "error") {
        const errorMsg =
          (msg.error as string) || String(msg.body) || "Node returned an error"
        throw new Error(errorMsg)
      }
    }

    return JSON.parse(accumulatedBodyParts.join("")) as T
  } finally {
    messages.dispose()
  }
}

type StreamErrorDetector = (chunk: StreamChunk) => HTTPError | null

/**
 * Peek at the first stream chunk, mapping both a failed pull and an error
 * frame to an `HTTPError` before the caller commits to streaming. Mimo's
 * stream is a WebSocket-backed `AsyncIterable`, not a `Response`, so
 * `safeSseStream` cannot be reused — but the shape is identical for both
 * wires; only the error-frame detector differs.
 */
async function safeMimoStream(
  gen: AsyncIterable<StreamChunk>,
  detectStreamError: StreamErrorDetector,
): Promise<AsyncIterable<StreamChunk>> {
  const iterator = gen[Symbol.asyncIterator]()
  let first: IteratorResult<StreamChunk>
  try {
    first = await iterator.next()
  } catch (e) {
    throw new HTTPError(
      e instanceof Error ? e.message : "Mimo stream error",
      new Response(null, { status: 503 }),
    )
  }
  if (first.done) return gen

  const streamError = detectStreamError(first.value)
  if (streamError) {
    await returnAsyncIterator(iterator)
    throw streamError
  }

  return {
    [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
      let yielded = false
      return {
        async next(): Promise<IteratorResult<StreamChunk>> {
          if (!yielded) {
            yielded = true
            return first
          }
          return iterator.next()
        },
        async return(): Promise<IteratorResult<StreamChunk>> {
          await returnAsyncIterator(iterator)
          return { done: true, value: undefined }
        },
      }
    },
  }
}

/**
 * Mimo's bridge sends bare `data` JSON frames (no SSE `event:` line), so the
 * Anthropic detector is used in data-only mode: the frame is recognized by
 * `type: "error"` and `error.type` backs up a missing `error.message`.
 */
const detectMimoAnthropicStreamError: StreamErrorDetector = (chunk) =>
  detectAnthropicStreamError(chunk, { typeAsMessageFallback: true })

export const mimoNativeAdapter: ProtocolAdapter = {
  protocol: "mimo-native",

  async createChatCompletions({ connection, credential, payload, signal }) {
    const conn = mimoConnections.get(connection.id)
    if (!conn) {
      markAccountFailed(connection.id, "Claw node is offline or initializing")
      throw new HTTPError(
        `Claw node for connection "${connection.name}" is offline or initializing. Please wait.`,
        new Response(null, { status: 503 }),
      )
    }

    const reqId = randomUUID()

    const nativePayload = {
      ...payload,
      model: parseModelReference(payload.model).nativeModelId,
    }

    const wsPayload = {
      type: "request",
      id: reqId,
      method: "POST",
      path: "/v1/chat/completions",
      body: nativePayload,
      headers: {},
      stream: payload.stream,
    }

    if (payload.stream) {
      const gen = streamResponse(conn, reqId, signal)
      conn.ws.send(serializeUpstreamBody(wsPayload))
      const response = await safeMimoStream(gen, detectOpenAIStreamError)
      return {
        credentialId: credential.id,
        response,
      }
    }

    const responsePromise = collectMimoResponse<ChatCompletionResponse>(
      conn,
      reqId,
      signal,
    )
    conn.ws.send(serializeUpstreamBody(wsPayload))
    const response = await responsePromise
    return {
      credentialId: credential.id,
      response,
    }
  },

  async createMessages({ connection, credential, payload, signal }) {
    const conn = mimoConnections.get(connection.id)
    if (!conn) {
      markAccountFailed(connection.id, "Claw node is offline or initializing")
      throw new HTTPError(
        `Claw node for connection "${connection.name}" is offline or initializing. Please wait.`,
        new Response(null, { status: 503 }),
      )
    }

    const reqId = randomUUID()

    // Pass raw Anthropic payload as-is (Mimo API supports native Anthropic protocol)
    const wsPayload = {
      type: "request",
      id: reqId,
      method: "POST",
      path: "/v1/messages",
      body: payload,
      headers: {},
      stream: payload.stream,
    }

    if (payload.stream) {
      const gen = streamResponse(conn, reqId, signal)
      conn.ws.send(serializeUpstreamBody(wsPayload))
      const response = await safeMimoStream(gen, detectMimoAnthropicStreamError)
      return {
        credentialId: credential.id,
        response,
      }
    }

    const responsePromise = collectMimoResponse<Record<string, unknown>>(
      conn,
      reqId,
      signal,
    )
    conn.ws.send(serializeUpstreamBody(wsPayload))
    const response = await responsePromise
    return {
      credentialId: credential.id,
      response,
    }
  },
}
