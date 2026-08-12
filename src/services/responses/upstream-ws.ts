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
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { globalTimers } from "~/lib/timer-registry"
import {
  buildUpstreamResponsesCreateBody,
  type UpstreamWsProvider,
} from "~/services/responses/upstream-ws-body"

import {
  createTurnConsumer,
  sessions,
  type TurnConsumer,
} from "./upstream-ws-consumer"
import { isChainedTurnUpstreamError } from "./upstream-ws-error"

export {
  buildUpstreamResponsesCreateBody,
  normalizeUpstreamWsEvent,
  type UpstreamWsProvider,
} from "~/services/responses/upstream-ws-body"

const CODEX_WS_BETA = "responses_websockets=2026-02-06"
/** Idle unused upstream sockets are closed after this many ms. */
const UPSTREAM_WS_IDLE_MS = 5 * 60_000
/**
 * Upstream sockets are force-closed by the provider after a hard limit, so we
 * proactively redial a fresh connection *before* it so a turn is never sent on
 * a socket about to be dropped. The cap is provider-specific:
 *   - Codex: ~60 min hard limit → redial at 55 min.
 *   - xAI:   documented 25 min cap → redial at 24 min.
 * store=true (forced for xAI) + previous_response_id (or full-input replay)
 * keep multi-turn chaining working across the redial.
 */
const UPSTREAM_WS_MAX_AGE_CODEX_MS = 55 * 60_000
const UPSTREAM_WS_MAX_AGE_XAI_MS = 24 * 60_000

/** Per-provider max socket age before a proactive redial. */
export function getUpstreamWsMaxAge(provider: UpstreamWsProvider): number {
  return provider === "xai" ?
      UPSTREAM_WS_MAX_AGE_XAI_MS
    : UPSTREAM_WS_MAX_AGE_CODEX_MS
}
/**
 * Max time to wait for the *first* upstream event after `response.create` is
 * sent. Codex/xAI emit `response.created` within ~1-2s; a freshly dialed
 * socket that silently accepts an oversized replay frame but never responds
 * would otherwise hang until the downstream client gives up. On timeout we
 * throw a transport error *before* returning the stream so the caller can
 * fall back to HTTP POST (which handles large bodies with no WS frame limit).
 */
const UPSTREAM_WS_FIRST_EVENT_TIMEOUT_MS = 60_000
/**
 * Max gap between events *after* streaming has started. A live Responses
 * stream emits events continuously; total silence this long means the socket
 * stalled mid-turn. Throwing frees the connection instead of hanging forever.
 * No HTTP fallback here — partial output may already have reached the client.
 */
const MAX_UPSTREAM_WS_REQUEST_BYTES = 16 * 1024 * 1024
const MAX_UPSTREAM_WS_SESSIONS = 1_024

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
  /** Correlates request-size checkpoints with the downstream WS turn. */
  memoryTraceId?: string
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
  return openUpstreamResponsesWebsocketTurnOnce(options, 1)
}

/**
 * One turn attempt over the upstream WebSocket (attempt 1 = normal, attempt 2
 * = full-input replay after a chained-turn rejection).
 *
 * A chained turn can be rejected upstream with "No tool call found for custom
 * tool call output ..." / previous_response_not_found when the server-side
 * conversation chain is missing — exactly what happens after an account switch
 * (the new credential's socket has zero upstream memory) or a socket redial.
 * When a self-contained replay body is available, retry once on a fresh socket
 * with the full input instead of failing the turn.
 */
async function openUpstreamResponsesWebsocketTurnOnce(
  options: UpstreamWsTurnOptions,
  attempt: number,
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
    if (sessions.size >= MAX_UPSTREAM_WS_SESSIONS) {
      pruneIdleUpstreamSessions()
      if (sessions.size >= MAX_UPSTREAM_WS_SESSIONS) {
        throw new Error(`${provider} websockets: session limit reached`)
      }
    }
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
  let consumer: TurnConsumer | undefined
  // Mutable state object so control-flow analysis keeps `replayed` a plain
  // boolean for the catch blocks below (it is only assigned inside `try`).
  const replayState = { replayed: false }
  try {
    if (signal?.aborted) {
      throw new Error(`${provider} websockets: aborted`)
    }

    const maxAgeMs = getUpstreamWsMaxAge(provider)
    const age = sess.openedAt > 0 ? Date.now() - sess.openedAt : 0
    const tooOld = age >= maxAgeMs
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
                maxAgeMs / 1000,
              )}s (avoid upstream hard limit)`,
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
    replayState.replayed = usedFallback
    if (usedFallback) {
      logger.info(
        `${provider} websockets: fresh socket cannot resolve previous_response_id=`
          + `${options.previousResponseId ?? ""}; replaying full input `
          + `session=${executionSessionId} auth=${account.id} `
          + `input_items=${Array.isArray(effectiveBody.input) ? effectiveBody.input.length : 0}`,
      )
      // Own stage (not just a detail field on the stringify/send stages below)
      // so telemetry can answer "did replay actually fire" independently of
      // whether a later stage in this trace overwrites `stage`.
      updateMemoryTrace(options.memoryTraceId, "transcript_replay_used", {
        provider,
      })
    }
    // Attach message/close/error listeners before sending. Very fast upstream
    // responses must not race past the first-event gate.
    consumer = createTurnConsumer({
      provider,
      accountId: account.id,
      executionSessionId,
      key,
      sess,
      ws,
      signal,
      releaseChain,
    })
    updateMemoryTrace(options.memoryTraceId, "upstream_ws_stringify_start", {
      provider,
      inputItems:
        Array.isArray(effectiveBody.input) ? effectiveBody.input.length : 0,
      replayedFullInput: usedFallback,
    })
    const wireBody = JSON.stringify(effectiveBody)
    const wireBytes = Buffer.byteLength(wireBody)
    updateMemoryTrace(options.memoryTraceId, "upstream_ws_send", {
      provider,
      wireBytes,
      upstreamBufferedBytes: ws.bufferedAmount,
      replayedFullInput: usedFallback,
    })
    if (wireBytes > MAX_UPSTREAM_WS_REQUEST_BYTES) {
      throw new Error(
        `${provider} websockets: upstream request exceeds WebSocket size limit`,
      )
    }
    ws.send(wireBody)
    updateMemoryTrace(options.memoryTraceId, "upstream_ws_sent", {
      provider,
      wireBytes,
      upstreamBufferedBytes: ws.bufferedAmount,
    })
    sess.lastUsedAt = Date.now()
  } catch (error) {
    consumer?.dispose()
    if (!consumer) releaseChain()
    if (
      retryChainedTurnOnce({
        options,
        key,
        provider,
        executionSessionId,
        accountId: account.id,
        attempt,
        alreadyReplayed: replayState.replayed,
        error,
      })
    ) {
      // The session was destroyed; the retry dials fresh and sends the
      // self-contained replay body.
      return openUpstreamResponsesWebsocketTurnOnce(options, attempt + 1)
    }
    // Drop half-open / failed sessions so the next turn redials.
    destroySession(key, "dial_or_send_failed")
    throw error
  }

  // Turn is live. Gate on the first upstream event so a silently stalled
  // socket (e.g. an oversized replay frame the upstream never processes)
  // throws a transport error *here* — letting the caller fall back to HTTP —
  // instead of hanging until the downstream client gives up.
  try {
    await consumer.waitForFirstEvent(UPSTREAM_WS_FIRST_EVENT_TIMEOUT_MS)
  } catch (error) {
    consumer.dispose()
    if (
      retryChainedTurnOnce({
        options,
        key,
        provider,
        executionSessionId,
        accountId: account.id,
        attempt,
        alreadyReplayed: replayState.replayed,
        error,
      })
    ) {
      return openUpstreamResponsesWebsocketTurnOnce(options, attempt + 1)
    }
    throw error
  }
  return consumer.iterate()
}

/**
 * Decide whether a rejected chained turn should be retried once with the
 * self-contained full-input replay on a fresh socket. Only the first attempt
 * may retry, and only when the request is actually chained
 * (previous_response_id), a replay body exists, and the upstream error is one
 * of the chain-missing signals.
 *
 * `alreadyReplayed` short-circuits the case where this attempt *already* sent
 * the full-input replay (the socket was dialed fresh, so selectUpstreamWsBody
 * picked the fallback) and upstream rejected it anyway — typically because the
 * transcript itself is missing the referenced tool call. Retrying would redial
 * and send a byte-identical body, so it can only fail the same way; surface
 * the error instead and let the provider turn it into the client-side replay
 * handshake.
 */
function retryChainedTurnOnce(params: {
  options: UpstreamWsTurnOptions
  key: string
  provider: UpstreamWsProvider
  executionSessionId: string
  accountId: string
  attempt: number
  alreadyReplayed: boolean
  error: unknown
}): boolean {
  const {
    options,
    key,
    provider,
    executionSessionId,
    accountId,
    attempt,
    alreadyReplayed,
    error,
  } = params
  if (
    attempt >= 2
    || alreadyReplayed
    || typeof options.previousResponseId !== "string"
    || options.previousResponseId.trim() === ""
    || options.fallbackFullInputBody === undefined
    || !isChainedTurnUpstreamError(error)
  ) {
    return false
  }
  destroySession(key, "chained_replay_retry")
  logger.info(
    `${provider} websockets: chained turn rejected upstream; retrying with `
      + `full-input replay session=${executionSessionId} auth=${accountId} `
      + `error=${error instanceof Error ? error.message : String(error)}`,
  )
  return true
}

/** @deprecated Prefer openUpstreamResponsesWebsocketTurn for eager open. */
export async function* streamUpstreamResponsesWebsocket(
  options: UpstreamWsTurnOptions,
): AsyncIterable<CopilotStreamEventLike> {
  const stream = await openUpstreamResponsesWebsocketTurn(options)
  yield* stream
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

globalTimers.interval(
  () => pruneIdleUpstreamSessions(),
  Math.min(UPSTREAM_WS_IDLE_MS, 60_000),
)

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

/**
 * Destroy a single upstream WS session (provider + account + execution). Used
 * by provider catch blocks on a `websocket_connection_limit_reached` frame so
 * the stale session is invalidated and the next turn truly redials (proactive
 * max-age alone is insufficient here).
 */
export function destroyUpstreamWebsocketSession(
  provider: UpstreamWsProvider,
  accountId: string,
  executionSessionId: string,
  reason = "invalidated",
): void {
  destroySession(sessionKey(provider, accountId, executionSessionId), reason)
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
