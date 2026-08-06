import { randomUUID } from "node:crypto"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"

interface ActiveWindsurfRequest {
  id: string
  startedAt: number
  streaming: boolean
}

interface BeginWindsurfRequestOptions {
  accountId: string
  accountLabel: string
  model: string
  streaming: boolean
  memoryTraceId?: string
}

export interface WindsurfConcurrencySnapshot {
  active: number
  streaming: number
  nonStreaming: number
  oldestAgeMs: number
}

const activeByAccount = new Map<string, Map<string, ActiveWindsurfRequest>>()
const DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 2
const MAX_CONCURRENT_PER_ACCOUNT = readConcurrencyLimit()

function readConcurrencyLimit(): number {
  const raw = process.env.WINDSURF_MAX_CONCURRENT_REQUESTS?.trim()
  if (!raw) return DEFAULT_MAX_CONCURRENT_PER_ACCOUNT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MAX_CONCURRENT_PER_ACCOUNT
  }
  return Math.min(parsed, 16)
}

export class WindsurfConcurrencyLimitError extends HTTPError {
  readonly accountId: string

  constructor(accountId: string, limit: number) {
    const headers = new Headers({
      "Retry-After": "1",
      "retry-after-ms": "1000",
    })
    const message = `Windsurf account concurrency limit reached (${limit}); retry shortly`
    super(message, new Response(null, { status: 429, headers }), message)
    this.name = "WindsurfConcurrencyLimitError"
    this.accountId = accountId
  }
}

export function getWindsurfConcurrencySnapshot(
  accountId: string,
): WindsurfConcurrencySnapshot {
  const active = activeByAccount.get(accountId)
  const now = Date.now()
  const requests = active ? [...active.values()] : []
  return {
    active: requests.length,
    streaming: requests.filter((request) => request.streaming).length,
    nonStreaming: requests.filter((request) => !request.streaming).length,
    oldestAgeMs:
      requests.length > 0 ?
        Math.max(...requests.map((request) => now - request.startedAt))
      : 0,
  }
}

export function beginWindsurfAccountRequest(
  options: BeginWindsurfRequestOptions,
): () => void {
  let active = activeByAccount.get(options.accountId)
  if (
    MAX_CONCURRENT_PER_ACCOUNT > 0
    && active
    && active.size >= MAX_CONCURRENT_PER_ACCOUNT
  ) {
    logger.warn("[windsurf] rejecting request at account concurrency limit", {
      accountId: options.accountId,
      accountLabel: options.accountLabel,
      model: options.model,
      active: active.size,
      limit: MAX_CONCURRENT_PER_ACCOUNT,
    })
    throw new WindsurfConcurrencyLimitError(
      options.accountId,
      MAX_CONCURRENT_PER_ACCOUNT,
    )
  }
  if (!active) {
    active = new Map()
    activeByAccount.set(options.accountId, active)
  }
  const request: ActiveWindsurfRequest = {
    id: randomUUID(),
    startedAt: Date.now(),
    streaming: options.streaming,
  }
  active.set(request.id, request)

  const started = getWindsurfConcurrencySnapshot(options.accountId)
  const details = {
    accountId: options.accountId,
    accountLabel: options.accountLabel,
    model: options.model,
    requestMode: options.streaming ? "streaming" : "non_streaming",
    ...started,
  }
  updateMemoryTrace(
    options.memoryTraceId,
    "windsurf_account_concurrency_enter",
    details,
  )
  if (started.active > 1) {
    logger.warn("[windsurf] concurrent requests on one account", details)
  } else {
    logger.info("[windsurf] account request started", details)
  }

  let released = false
  return () => {
    if (released) return
    released = true
    const current = activeByAccount.get(options.accountId)
    current?.delete(request.id)
    if (current?.size === 0) activeByAccount.delete(options.accountId)
    const remaining = getWindsurfConcurrencySnapshot(options.accountId)
    const completed = {
      accountId: options.accountId,
      accountLabel: options.accountLabel,
      model: options.model,
      requestMode: options.streaming ? "streaming" : "non_streaming",
      durationMs: Date.now() - request.startedAt,
      ...remaining,
    }
    updateMemoryTrace(
      options.memoryTraceId,
      "windsurf_account_concurrency_leave",
      completed,
    )
    logger.info("[windsurf] account request completed", completed)
  }
}

export function resetWindsurfConcurrencyForTest(): void {
  activeByAccount.clear()
}
