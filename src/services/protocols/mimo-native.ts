/**
 * Mimo Native Protocol Adapter。
 *
 * 把 legacy Mimo Account 路径(WebSocket)封装为 ProtocolAdapter,
 * 使 executeWithFailover 统一调度。
 */

import { randomUUID } from "node:crypto"

import type { Account } from "~/lib/accounts"
import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"

import { parseModelReference } from "~/lib/accounts"
import {
  type MimoMessage,
  type MimoConnection,
  mimoConnections,
} from "~/services/mimo/connections"

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

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("mimo-native adapter: target.account is required")
  }
  return account
}

async function* streamResponse(
  conn: MimoConnection,
  reqId: string,
  signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const queue: Array<MimoMessage> = []
  let resolveNext: (() => void) | null = null
  let done = false
  let error: Error | null = null
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
    queue.push(msg)
    resetIdleTimer()
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  conn.activeRequests.set(reqId, listener)

  const cleanup = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    conn.activeRequests.delete(reqId)
  }

  if (signal) {
    signal.addEventListener("abort", () => {
      error = new Error("Request aborted")
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
    })
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

      if (msg.type === "stream_start") {
        // Ignore: status/headers already captured by bridge protocol.
        // Keeping this branch prevents silent discard of upstream HTTP status.
      } else if (msg.type === "response" && msg.body) {
        // Non-SSE reply arrived while expecting a stream (e.g. upstream error).
        // Yield as a single SSE data line then finish, matching mimo-claw behavior.
        const bodyStr = JSON.stringify(msg.body)
        yield { data: bodyStr }
        done = true
      } else if (msg.type === "stream_delta" && msg.chunk) {
        // Bridge.py already strips "data: " prefix, chunk is raw JSON
        yield { data: msg.chunk }
      } else if (msg.type === "stream_end") {
        done = true
      } else if (msg.type === "error") {
        throw new Error(
          ((msg.error || msg.body) as string) || "Node returned an error",
        )
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
  let resolveNext: (() => void) | null = null
  let done = false
  let error: Error | null = null
  let accumulatedBody = ""
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
    queue.push(msg)
    resetIdleTimer()
    if (resolveNext) {
      resolveNext()
      resolveNext = null
    }
  }

  conn.activeRequests.set(reqId, listener)

  const cleanup = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    conn.activeRequests.delete(reqId)
  }

  if (signal) {
    signal.addEventListener("abort", () => {
      error = new Error("Request aborted")
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
    })
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

      if (msg.type === "stream_start") {
        // Ignore: non-streaming path — status/headers not needed here.
      } else if (msg.type === "stream_delta" && msg.chunk) {
        accumulatedBody += msg.chunk
      } else if (msg.type === "stream_end") {
        done = true
      } else if (msg.type === "response" && msg.body) {
        return msg.body as ChatCompletionResponse
      } else if (msg.type === "error") {
        throw new Error(
          ((msg.error || msg.body) as string) || "Node returned an error",
        )
      }
    }

    return JSON.parse(accumulatedBody) as ChatCompletionResponse
  } finally {
    cleanup()
  }
}

export const mimoNativeAdapter: ProtocolAdapter = {
  protocol: "mimo-native",

  // eslint-disable-next-line max-params
  async createChatCompletions(
    target,
    _connection,
    _credential,
    payload,
    signal,
    _ctx,
  ) {
    const account = extractAccount(target)
    const conn = mimoConnections.get(account.id)
    if (!conn) {
      throw new Error(
        `Claw node for account "${account.label}" is offline or initializing. Please wait.`,
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
      const response = streamResponse(conn, reqId, signal)
      conn.ws.send(JSON.stringify(wsPayload))
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
}
