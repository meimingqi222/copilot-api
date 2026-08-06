import { randomUUID } from "node:crypto"

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
  const request: ActiveWindsurfRequest = {
    id: randomUUID(),
    startedAt: Date.now(),
    streaming: options.streaming,
  }
  let active = activeByAccount.get(options.accountId)
  if (!active) {
    active = new Map()
    activeByAccount.set(options.accountId, active)
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
