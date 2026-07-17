/**
 * Upstream Responses API WebSocket transport (CPA-aligned).
 *
 * Used by Codex and xAI when:
 *   1. Downstream client connected via WebSocket (`ctx.downstreamWebsocket`)
 *   2. Account has websockets enabled (default true for codex/xai)
 *
 * Mirrors CLIProxyAPI:
 *   - codex_websockets_executor.go
 *   - xai_websockets_executor.go
 */

import type { Account } from "~/lib/accounts"
import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"

import { getOAuthProxyUrl } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"

export type UpstreamWsProvider = "codex" | "xai"

const CODEX_WS_BETA = "responses_websockets=2026-02-06"
/** Idle unused upstream sockets are closed after this many ms. */
const UPSTREAM_WS_IDLE_MS = 5 * 60_000
/**
 * Upstream (xAI/Codex) sockets are force-closed by the provider at ~60 min.
 * Proactively redial a fresh connection before that hard limit so a turn is
 * never sent on a socket that is about to be dropped. store=true (forced for
 * xAI) + previous_response_id keep multi-turn chaining working across the
 * redial via the provider's server-side response store.
 */
const UPSTREAM_WS_MAX_AGE_MS = 55 * 60_000

/** Convert HTTP(S) responses URL to ws(s). */
export function buildResponsesWebsocketUrl(httpUrl: string): string {
  const parsed = new URL(httpUrl.trim())
  switch (parsed.protocol) {
    case "http:": {
      parsed.protocol = "ws:"
      break
    }
    case "https:": {
      parsed.protocol = "wss:"
      break
    }
    case "ws:":
    case "wss:": {
      break
    }
    default: {
      throw new Error(
        `unsupported responses websocket URL scheme: ${parsed.protocol}`,
      )
    }
  }
  if (!parsed.host) {
    throw new Error("responses websocket URL host is empty")
  }
  return parsed.toString()
}

/**
 * Whether this account should use upstream Responses WebSocket transport.
 *
 * Explicit `settings.websockets` / `cpaMetadata.websockets` wins.
 * For codex/xai, default is **true** (native WS supported) so WS clients
 * get the correct path without admin configuration. Set `websockets: false`
 * to force HTTP.
 */
export function isAccountWebsocketsEnabled(
  account: Account,
  _provider: UpstreamWsProvider,
): boolean {
  const explicit = readWebsocketsFlag(account)
  if (explicit !== undefined) return explicit
  // codex/xai callers only — default on so WS clients get upstream WSS.
  return true
}

function readWebsocketsFlag(account: Account): boolean | undefined {
  const fromSettings = parseBoolish(account.settings?.["websockets"])
  if (fromSettings !== undefined) return fromSettings
  const fromMeta = parseBoolish(account.cpaMetadata?.["websockets"])
  if (fromMeta !== undefined) return fromMeta
  return undefined
}

function parseBoolish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const t = value.trim().toLowerCase()
    if (t === "true" || t === "1" || t === "yes") return true
    if (t === "false" || t === "0" || t === "no") return false
  }
  return undefined
}

export function shouldUseUpstreamResponsesWebsocket(
  account: Account,
  provider: UpstreamWsProvider,
  ctx?: { downstreamWebsocket?: boolean },
): boolean {
  if (!ctx?.downstreamWebsocket) return false
  if (!isAccountWebsocketsEnabled(account, provider)) return false
  // Bun WebSocket does not support HTTP CONNECT proxies yet — fall back.
  if (getOAuthProxyUrl(account)) {
    logger.warn(
      `${provider} websockets: account proxy is set; falling back to HTTP POST (proxy not supported for upstream WS)`,
    )
    return false
  }
  return true
}

/**
 * Build the wire JSON for `response.create` on the upstream WS.
 * Strips transport-only fields per xAI/Codex docs.
 */
export function buildUpstreamResponsesCreateBody(
  body: Record<string, unknown>,
  options: { provider: UpstreamWsProvider },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, type: "response.create" }
  delete out.stream
  delete out.stream_options
  delete out.background

  if (options.provider === "xai") {
    // CPA forces store=true so connection-cache + previous_response_id work
    // under multi-turn WS (and survives reconnect with store).
    out.store = true
    if (
      typeof out.previous_response_id === "string"
      && out.previous_response_id.trim()
    ) {
      delete out.instructions
    }
  }

  return out
}

export function applyCodexWebsocketHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const next = { ...headers }
  const beta = next["OpenAI-Beta"] || next["openai-beta"] || ""
  if (!beta.includes("responses_websockets=")) {
    next["OpenAI-Beta"] = CODEX_WS_BETA
  }
  // WS responses are event messages, not SSE.
  delete next.Accept
  return next
}

export function applyXaiWebsocketHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const next = { ...headers }
  delete next.Accept
  return next
}

/** True when fallback to HTTP should be attempted (transport only). */
export function isUpstreamWsTransportError(error: unknown): boolean {
  if (error instanceof HTTPError) return false
  if (isAbortLikeError(error)) return false
  if (!(error instanceof Error)) return true
  const msg = error.message.toLowerCase()
  return (
    msg.includes("handshake")
    || msg.includes("socket")
    || msg.includes("websocket")
    || msg.includes("connection not open")
    || msg.includes("closed during")
    || msg.includes("closed unexpectedly")
    || msg.includes("timeout")
  )
}

export function isAbortLikeError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError") return true
    return /abort/i.test(error.message)
  }
  if (typeof error === "string") return /abort/i.test(error)
  return false
}

// ── Session-backed upstream WS ────────────────────────────────────────

interface UpstreamWsSession {
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

const sessions = new Map<string, UpstreamWsSession>()

function sessionKey(
  provider: UpstreamWsProvider,
  accountId: string,
  executionSessionId: string,
): string {
  return `${provider}::${accountId}::${executionSessionId}`
}

export interface UpstreamWsTurnOptions {
  provider: UpstreamWsProvider
  account: Account
  httpResponsesUrl: string
  headers: Record<string, string>
  body: Record<string, unknown>
  /** Sticky key for connection reuse (downstream WS session id). */
  executionSessionId: string
  signal?: AbortSignal
  /**
   * The `previous_response_id` the client is chaining from (if any). Used
   * together with `fallbackFullInputBody` to recover when the turn lands on a
   * freshly dialed upstream socket that cannot resolve it (store=false).
   */
  previousResponseId?: string
  /**
   * A self-contained request body (full input, no `previous_response_id`) to
   * send instead of `body` when the socket is freshly opened. Only Codex
   * supplies this; xAI relies on store=true to survive redials.
   */
  fallbackFullInputBody?: Record<string, unknown>
}

/**
 * Decides which request body to send on the upstream socket.
 *
 * A freshly opened socket has no server-side response store (Codex forces
 * store=false), so any `previous_response_id` on it is guaranteed unresolvable.
 * When that happens and a self-contained fallback body is available, send the
 * fallback (full input, no previous_response_id) instead of the incremental
 * body. A reused, still-live socket keeps chaining with the incremental body.
 */
export function selectUpstreamWsBody(params: {
  openedFresh: boolean
  previousResponseId?: string
  incrementalBody: Record<string, unknown>
  fallbackFullInputBody?: Record<string, unknown>
  provider: UpstreamWsProvider
}): { body: Record<string, unknown>; usedFallback: boolean } {
  const { openedFresh, previousResponseId, incrementalBody } = params
  const chaining =
    typeof previousResponseId === "string" && previousResponseId.trim() !== ""
  if (openedFresh && chaining && params.fallbackFullInputBody) {
    return {
      body: buildUpstreamResponsesCreateBody(params.fallbackFullInputBody, {
        provider: params.provider,
      }),
      usedFallback: true,
    }
  }
  return { body: incrementalBody, usedFallback: false }
}

/**
 * Open (or reuse) an upstream WS, send `response.create`, then return a
 * stream of events. Handshake/send failures throw **before** the stream is
 * returned so callers can catch and fall back to HTTP for streaming clients.
 */
export async function openUpstreamResponsesWebsocketTurn(
  options: UpstreamWsTurnOptions,
): Promise<AsyncIterable<CopilotStreamEventLike>> {
  const {
    provider,
    account,
    httpResponsesUrl,
    headers,
    body,
    executionSessionId,
    signal,
  } = options

  if (signal?.aborted) {
    throw new Error(`${provider} websockets: aborted`)
  }

  const wsUrl = buildResponsesWebsocketUrl(httpResponsesUrl)
  const key = sessionKey(provider, account.id, executionSessionId)
  const wsBody = buildUpstreamResponsesCreateBody(body, { provider })

  const prevId =
    typeof wsBody.previous_response_id === "string" ?
      wsBody.previous_response_id
    : ""
  const generateLog =
    (
      typeof wsBody.generate === "boolean"
      || typeof wsBody.generate === "string"
    ) ?
      String(wsBody.generate)
    : "default"
  logger.info(
    `${provider} websockets: upstream request session=${executionSessionId} `
      + `auth=${account.id} url=${wsUrl} event=response.create `
      + `previous_response_id=${prevId} generate=${generateLog} `
      + `input_items=${Array.isArray(wsBody.input) ? wsBody.input.length : 0}`,
  )

  pruneIdleUpstreamSessions()

  // Per-key chain: dial + send are serialized so concurrent turns cannot
  // double-open and orphan sockets.
  let sess = sessions.get(key)
  if (!sess) {
    sess = {
      key,
      provider,
      executionSessionId,
      url: wsUrl,
      accountId: account.id,
      ws: null,
      chain: Promise.resolve(),
      closed: true,
      lastUsedAt: Date.now(),
      openedAt: 0,
    }
    sessions.set(key, sess)
  }

  const prev = sess.chain
  let releaseChain!: () => void
  sess.chain = new Promise<void>((resolve) => {
    releaseChain = resolve
  })
  await prev

  let ws: WebSocket
  let openedFresh = false
  try {
    if (signal?.aborted) {
      throw new Error(`${provider} websockets: aborted`)
    }

    const age = sess.openedAt > 0 ? Date.now() - sess.openedAt : 0
    const tooOld = age >= UPSTREAM_WS_MAX_AGE_MS
    const live =
      sess.ws !== null
      && !sess.closed
      && sess.ws.readyState === WebSocket.OPEN
      && !tooOld
    if (!live) {
      if (sess.ws !== null && !sess.closed) {
        if (tooOld) {
          logger.info(
            `${provider} websockets: redialing session=${executionSessionId} `
              + `age=${Math.round(age / 1000)}s >= max=${Math.round(
                UPSTREAM_WS_MAX_AGE_MS / 1000,
              )}s (avoid upstream ~60m hard limit)`,
          )
        }
        try {
          sess.ws.close()
        } catch {
          // ignore
        }
      }
      const opened = await openSession({
        key,
        provider,
        executionSessionId,
        url: wsUrl,
        accountId: account.id,
        headers,
      })
      sess.ws = opened.ws
      sess.closed = false
      sess.url = wsUrl
      sess.openedAt = Date.now()
      sess.lastUsedAt = Date.now()
      openedFresh = true
    }

    if (sess.ws === null) {
      throw new Error(`${provider} websockets: connection not open`)
    }
    ws = sess.ws
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error(`${provider} websockets: connection not open`)
    }
    const { body: effectiveBody, usedFallback } = selectUpstreamWsBody({
      openedFresh,
      previousResponseId: options.previousResponseId,
      incrementalBody: wsBody,
      fallbackFullInputBody: options.fallbackFullInputBody,
      provider,
    })
    if (usedFallback) {
      logger.info(
        `${provider} websockets: fresh socket cannot resolve previous_response_id=`
          + `${options.previousResponseId ?? ""}; replaying full input `
          + `session=${executionSessionId} auth=${account.id} `
          + `input_items=${Array.isArray(effectiveBody.input) ? effectiveBody.input.length : 0}`,
      )
    }
    ws.send(JSON.stringify(effectiveBody))
    sess.lastUsedAt = Date.now()
  } catch (error) {
    releaseChain()
    // Drop half-open / failed sessions so the next turn redials.
    destroySession(key, "dial_or_send_failed")
    throw error
  }

  // Turn is live: consume events until terminal. Release chain in finally.
  return streamTurnEvents({
    provider,
    accountId: account.id,
    executionSessionId,
    key,
    sess,
    ws,
    signal,
    releaseChain,
  })
}

/** @deprecated Prefer openUpstreamResponsesWebsocketTurn for eager open. */
export async function* streamUpstreamResponsesWebsocket(
  options: UpstreamWsTurnOptions,
): AsyncIterable<CopilotStreamEventLike> {
  const stream = await openUpstreamResponsesWebsocketTurn(options)
  yield* stream
}

async function* streamTurnEvents(options: {
  provider: UpstreamWsProvider
  accountId: string
  executionSessionId: string
  key: string
  sess: UpstreamWsSession
  ws: WebSocket
  signal?: AbortSignal
  releaseChain: () => void
}): AsyncIterable<CopilotStreamEventLike> {
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
  let wake: (() => void) | undefined
  let fail: ((err: Error) => void) | undefined
  let done = false
  let terminalError: Error | undefined

  const notify = () => {
    wake?.()
    wake = undefined
  }

  const rejectWait = (err: Error) => {
    terminalError = err
    done = true
    fail?.(err)
    fail = undefined
    wake = undefined
  }

  const onMessage = (event: MessageEvent) => {
    let data = ""
    if (typeof event.data === "string") {
      data = event.data
    } else if (event.data instanceof ArrayBuffer) {
      data = new TextDecoder().decode(event.data)
    }
    if (!data) return
    queue.push(data)
    notify()
  }
  const onError = () => {
    rejectWait(new Error(`${provider} websockets: upstream socket error`))
    notify()
  }
  const onClose = () => {
    sess.closed = true
    if (sessions.get(key) === sess) {
      sessions.delete(key)
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

  try {
    while (!done) {
      if (terminalError) throw terminalError
      if (signal?.aborted) {
        throw new Error(`${provider} websockets: aborted`)
      }

      if (queue.length === 0) {
        await new Promise<void>((resolve, reject) => {
          wake = resolve
          fail = reject
        })
        continue
      }

      const raw = queue.shift()
      if (raw === undefined) continue
      yield { data: raw }

      let parsed: Record<string, unknown> | undefined
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch {
        continue
      }

      const eventType = typeof parsed.type === "string" ? parsed.type : ""
      if (eventType === "error" || eventType === "response.failed") {
        const message = extractWsErrorMessage(parsed)
        const status = extractWsErrorStatus(parsed)
        throw new HTTPError(
          `${provider} websockets: ${message}`,
          new Response(raw, { status }),
          raw,
        )
      }
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
    signal?.removeEventListener("abort", onAbort)
    ws.removeEventListener("message", onMessage)
    ws.removeEventListener("error", onError)
    ws.removeEventListener("close", onClose)
    releaseChain()
  }
}

async function openSession(options: {
  key: string
  provider: UpstreamWsProvider
  executionSessionId: string
  url: string
  accountId: string
  headers: Record<string, string>
}): Promise<{ ws: WebSocket }> {
  const { key, provider, url, accountId, headers } = options

  logger.info(
    `${provider} websockets: upstream connecting session=${key} auth=${accountId} url=${url}`,
  )

  const ws = new WebSocket(url, {
    // Bun extension: custom handshake headers
    headers,
  } as unknown as string)

  await waitForOpen(ws, provider)

  logger.info(
    `${provider} websockets: upstream connected session=${key} auth=${accountId} url=${url}`,
  )

  return { ws }
}

function waitForOpen(
  ws: WebSocket,
  provider: UpstreamWsProvider,
): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      try {
        ws.close()
      } catch {
        // ignore
      }
      reject(new Error(`${provider} websockets: handshake timeout`))
    }, 30_000)
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(`${provider} websockets: handshake failed`))
    }
    const onClose = () => {
      cleanup()
      reject(new Error(`${provider} websockets: closed during handshake`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
      ws.removeEventListener("close", onClose)
    }
    ws.addEventListener("open", onOpen)
    ws.addEventListener("error", onError)
    ws.addEventListener("close", onClose)
  })
}

function extractWsErrorMessage(parsed: Record<string, unknown>): string {
  const err = parsed.error
  if (err && typeof err === "object") {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === "string" && msg.trim()) return msg
    const code = (err as { code?: unknown }).code
    if (typeof code === "string" && code.trim()) return code
  }
  if (typeof parsed.message === "string" && parsed.message.trim()) {
    return parsed.message
  }
  return "upstream websocket error"
}

function extractWsErrorStatus(parsed: Record<string, unknown>): number {
  if (typeof parsed.status === "number" && parsed.status >= 400) {
    return parsed.status
  }
  const err = parsed.error
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status
    if (typeof status === "number" && status >= 400) return status
  }
  return 400
}

function readResponseId(parsed: Record<string, unknown>): string {
  const response = parsed.response
  if (response && typeof response === "object") {
    const id = (response as { id?: unknown }).id
    if (typeof id === "string") return id
  }
  return ""
}

function destroySession(key: string, reason: string): void {
  const sess = sessions.get(key)
  if (!sess) return
  sessions.delete(key)
  sess.closed = true
  if (sess.ws !== null) {
    try {
      sess.ws.close()
    } catch {
      // ignore
    }
    sess.ws = null
  }
  logger.info(
    `${sess.provider} websockets: upstream disconnected session=${sess.executionSessionId} `
      + `auth=${sess.accountId} url=${sess.url || "(none)"} reason=${reason}`,
  )
}

function pruneIdleUpstreamSessions(now = Date.now()): void {
  for (const [key, sess] of sessions) {
    if (sess.closed) {
      sessions.delete(key)
      continue
    }
    if (now - sess.lastUsedAt > UPSTREAM_WS_IDLE_MS) {
      destroySession(key, "idle_timeout")
    }
  }
}

/**
 * Close all upstream WS sessions bound to a downstream execution session
 * (client socket id). Call when the client Responses WebSocket closes.
 */
export function closeUpstreamWebsocketSessionsByExecutionId(
  executionSessionId: string,
  reason = "client_disconnect",
): number {
  const id = executionSessionId.trim()
  if (!id) return 0
  let closed = 0
  for (const [key, sess] of sessions.entries()) {
    if (sess.executionSessionId === id) {
      destroySession(key, reason)
      closed += 1
    }
  }
  return closed
}

/** Test hook: drop all cached upstream sockets. */
export function clearUpstreamWebsocketSessionsForTest(): void {
  for (const key of sessions.keys()) {
    destroySession(key, "test_clear")
  }
  sessions.clear()
}

/** Test hook: live session count. */
export function getUpstreamWebsocketSessionCountForTest(): number {
  return sessions.size
}
