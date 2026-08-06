/**
 * Mimo Native Protocol Adapter。
 *
 * 把 legacy Mimo Account 路径(WebSocket)封装为 ProtocolAdapter,
 * 使 executeWithFailover 统一调度。
 */

import { randomUUID } from "node:crypto"

import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import { parseModelReference } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { connectionToAccount } from "~/lib/provider-connections"
import {
  type MimoMessage,
  type MimoConnection,
  mimoConnections,
} from "~/services/mimo/connections"
import { markAccountFailed } from "~/services/mimo/manager"
import { MAX_MIMO_RESPONSE_BYTES } from "~/services/mimo/ws-proxy"
import { detectOpenAIStreamError } from "~/services/protocols/shared"

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

async function* streamResponse(
  conn: MimoConnection,
  reqId: string,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const queue: Array<MimoMessage> = []
  let queuedBytes = 0
  let resolveNext: (() => void) | null = null
  let done = false
  let error: Error | null = null
  let idleTimeoutId: ReturnType<typeof setTimeout> | null = null
  let responseBytes = 0

  const resetIdleTimer = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    idleTimeoutId = setTimeout(() => {
      error = new Error(IDLE_TIMEOUT_MESSAGE)
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
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
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
      return
    }
    queue.push(msg)
    queuedBytes += messageBytes
    resetIdleTimer()
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  conn.activeRequests.set(reqId, listener)

  const cleanup = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    queue.length = 0
    queuedBytes = 0
    conn.activeRequests.delete(reqId)
    if (signal) signal.removeEventListener("abort", onAbort)
  }

  const onAbort = () => {
    error = new Error("Request aborted")
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }

  resetIdleTimer()

  try {
    while (!done) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/only-throw-error
      if (error) throw error

      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/only-throw-error
      if (error) throw error

      const msg = queue.shift()
      if (!msg) continue
      queuedBytes -= getMimoMessageBytes(msg)

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
        done = true
      } else if (msg.type === "stream_delta" && msg.chunk) {
        // Bridge.py already strips "data: " prefix, chunk is raw JSON
        responseBytes += Buffer.byteLength(msg.chunk)
        if (responseBytes > MAX_MIMO_RESPONSE_BYTES) {
          throw new Error("Mimo response exceeds the maximum size")
        }
        yield { data: msg.chunk }
      } else if (msg.type === "stream_end") {
        done = true
      } else if (msg.type === "error") {
        const errorMsg =
          (msg.error as string) || String(msg.body) || "Node returned an error"
        throw new Error(errorMsg)
      }
    }
    yield { data: "[DONE]" }
  } finally {
    cleanup()
  }
}

async function collectResponse(
  conn: MimoConnection,
  reqId: string,
  signal?: AbortSignal,
): Promise<ChatCompletionResponse> {
  const queue: Array<MimoMessage> = []
  let queuedBytes = 0
  let resolveNext: (() => void) | null = null
  let done = false
  let error: Error | null = null
  const accumulatedBodyParts: Array<string> = []
  let accumulatedBytes = 0
  let idleTimeoutId: ReturnType<typeof setTimeout> | null = null

  const resetIdleTimer = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    idleTimeoutId = setTimeout(() => {
      error = new Error(IDLE_TIMEOUT_MESSAGE)
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
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
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
      return
    }
    queue.push(msg)
    queuedBytes += messageBytes
    resetIdleTimer()
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  conn.activeRequests.set(reqId, listener)

  const cleanup = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    queue.length = 0
    queuedBytes = 0
    conn.activeRequests.delete(reqId)
    if (signal) signal.removeEventListener("abort", onAbort)
  }

  const onAbort = () => {
    error = new Error("Request aborted")
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }

  resetIdleTimer()

  try {
    while (!done) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/only-throw-error
      if (error) throw error

      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/only-throw-error
      if (error) throw error

      const msg = queue.shift()
      if (!msg) continue
      queuedBytes -= getMimoMessageBytes(msg)

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
        done = true
      } else if (msg.type === "response" && msg.body) {
        if (getMimoMessageBytes(msg) > MAX_MIMO_RESPONSE_BYTES) {
          throw new Error("Mimo response exceeds the maximum size")
        }
        return msg.body as ChatCompletionResponse
      } else if (msg.type === "error") {
        const errorMsg =
          (msg.error as string) || String(msg.body) || "Node returned an error"
        throw new Error(errorMsg)
      }
    }

    return JSON.parse(accumulatedBodyParts.join("")) as ChatCompletionResponse
  } finally {
    cleanup()
  }
}

async function safeMimoStream(
  gen: AsyncIterable<StreamChunk>,
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

  const streamError = detectOpenAIStreamError(first.value)
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
 * Peek at the first stream chunk for Anthropic error format.
 * Mimo bridge sends raw JSON in stream_delta.chunk.
 * Anthropic error format: {"type":"error","error":{...}}
 */
function detectMimoAnthropicStreamError(chunk: StreamChunk): HTTPError | null {
  if (!chunk.data) return null
  try {
    const parsed = JSON.parse(chunk.data) as {
      type?: string
      error?: { message?: string; type?: string }
    }
    if (parsed.type === "error") {
      const err = parsed.error ?? {}
      return new HTTPError(
        err.message ?? err.type ?? "upstream streaming error",
        new Response(null, { status: 500 }),
        chunk.data,
      )
    }
  } catch {
    /* ignore parse errors */
  }
  return null
}

async function safeMimoMessagesStream(
  gen: AsyncIterable<StreamChunk>,
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

  const streamError = detectMimoAnthropicStreamError(first.value)
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
 * Collect a non-streaming response for the messages endpoint.
 * Handles both accumulated stream deltas and direct response messages.
 */
async function collectMessagesResponse(
  conn: MimoConnection,
  reqId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const queue: Array<MimoMessage> = []
  let queuedBytes = 0
  let resolveNext: (() => void) | null = null
  let done = false
  let error: Error | null = null
  const accumulatedBodyParts: Array<string> = []
  let accumulatedBytes = 0
  let idleTimeoutId: ReturnType<typeof setTimeout> | null = null

  const resetIdleTimer = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    idleTimeoutId = setTimeout(() => {
      error = new Error(IDLE_TIMEOUT_MESSAGE)
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
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
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
      return
    }
    queue.push(msg)
    queuedBytes += messageBytes
    resetIdleTimer()
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  conn.activeRequests.set(reqId, listener)

  const cleanup = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    queue.length = 0
    queuedBytes = 0
    conn.activeRequests.delete(reqId)
    if (signal) signal.removeEventListener("abort", onAbort)
  }

  const onAbort = () => {
    error = new Error("Request aborted")
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }

  resetIdleTimer()

  try {
    while (!done) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/only-throw-error
      if (error) throw error

      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve
        })
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/only-throw-error
      if (error) throw error

      const msg = queue.shift()
      if (!msg) continue
      queuedBytes -= getMimoMessageBytes(msg)

      if (msg.type === "stream_start") {
        // Ignore
      } else if (msg.type === "stream_delta" && msg.chunk) {
        const chunkBytes = Buffer.byteLength(msg.chunk)
        accumulatedBytes += chunkBytes
        if (accumulatedBytes > MAX_MIMO_RESPONSE_BYTES) {
          throw new Error("Mimo response exceeds the maximum size")
        }
        accumulatedBodyParts.push(msg.chunk)
      } else if (msg.type === "stream_end") {
        done = true
      } else if (msg.type === "response" && msg.body) {
        if (getMimoMessageBytes(msg) > MAX_MIMO_RESPONSE_BYTES) {
          throw new Error("Mimo response exceeds the maximum size")
        }
        return msg.body as Record<string, unknown>
      } else if (msg.type === "error") {
        const errorMsg =
          (msg.error as string) || String(msg.body) || "Node returned an error"
        throw new Error(errorMsg)
      }
    }

    return JSON.parse(accumulatedBodyParts.join("")) as Record<string, unknown>
  } finally {
    cleanup()
  }
}

export const mimoNativeAdapter: ProtocolAdapter = {
  protocol: "mimo-native",

  async createChatCompletions({ connection, payload, signal }) {
    const account = connectionToAccount(connection)
    const conn = mimoConnections.get(account.id)
    if (!conn) {
      markAccountFailed(account.id, "Claw node is offline or initializing")
      throw new HTTPError(
        `Claw node for account "${account.label}" is offline or initializing. Please wait.`,
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
      conn.ws.send(JSON.stringify(wsPayload))
      const response = await safeMimoStream(gen)
      return {
        credentialId: account.id,
        response,
      }
    }

    const responsePromise = collectResponse(conn, reqId, signal)
    conn.ws.send(JSON.stringify(wsPayload))
    const response = await responsePromise
    return {
      credentialId: account.id,
      response,
    }
  },

  async createMessages({ connection, payload, signal }) {
    const account = connectionToAccount(connection)
    const conn = mimoConnections.get(account.id)
    if (!conn) {
      markAccountFailed(account.id, "Claw node is offline or initializing")
      throw new HTTPError(
        `Claw node for account "${account.label}" is offline or initializing. Please wait.`,
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
      conn.ws.send(JSON.stringify(wsPayload))
      const response = await safeMimoMessagesStream(gen)
      return {
        credentialId: account.id,
        response,
      }
    }

    const responsePromise = collectMessagesResponse(conn, reqId, signal)
    conn.ws.send(JSON.stringify(wsPayload))
    const response = await responsePromise
    return {
      credentialId: account.id,
      response,
    }
  },
}
