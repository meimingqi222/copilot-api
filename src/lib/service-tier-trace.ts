import type { Context } from "hono"

import { logger } from "~/lib/logger"
import { readOpenAIServiceTier } from "~/lib/service-tier"
import {
  getRequestLogContext,
  patchRequestLog,
  publishTraceSnapshot,
} from "~/lib/request-log"

const attemptsAtSend = new WeakMap<Context, number>()

function payloadTier(payload: unknown): string | undefined {
  return payload && typeof payload === "object" ?
      readOpenAIServiceTier((payload as Record<string, unknown>).service_tier)
    : undefined
}

export function recordRequestedServiceTier(c: Context, payload: unknown): void {
  patchRequestLog(c, {
    serviceTierRequested: payloadTier(payload) ?? "default",
  })
}

export function recordRoutedServiceTier(
  c: Context | undefined,
  payload: unknown,
): void {
  if (c)
    patchRequestLog(c, { serviceTierRouted: payloadTier(payload) ?? "default" })
}

export function recordSentServiceTier(
  c: Context | undefined,
  value: unknown,
): void {
  if (!c) return
  const tier = readOpenAIServiceTier(value) ?? "default"
  attemptsAtSend.set(c, getRequestLogContext(c)?.entry.attempts?.length ?? 0)
  patchRequestLog(c, {
    serviceTierUpstream: tier,
    serviceTierResponse: undefined,
  })
  logger.debug("[codex] outbound service tier", {
    serviceTier: tier,
    requestId: getRequestLogContext(c)?.requestId,
  })
  publishTraceSnapshot(c, "update")
}

export function observeResponseServiceTier(
  c: Context | undefined,
  response: unknown,
): void {
  if (!c || !response || typeof response !== "object") return
  const record = response as Record<string, unknown>
  if (
    typeof record.type === "string"
    && record.type !== "response.completed"
    && record.type !== "response.incomplete"
  )
    return
  const tier = payloadTier(record.response) ?? payloadTier(record)
  if (!tier) return
  const ctx = getRequestLogContext(c)
  if (!ctx || ctx.entry.serviceTierResponse === tier) return
  patchRequestLog(c, { serviceTierResponse: tier })
  const attempt = ctx.entry.attempts?.at(-1)
  if (
    attempt?.provider === "codex"
    && (ctx.entry.attempts?.length ?? 0)
      > (attemptsAtSend.get(c) ?? Number.POSITIVE_INFINITY)
  )
    attempt.serviceTierResponse = tier
  logger.debug("[codex] reported service tier", {
    serviceTier: tier,
    requestId: ctx.requestId,
  })
  publishTraceSnapshot(c, "update")
}

export async function* observeServiceTierStream<T extends { data?: string }>(
  source: AsyncIterable<T>,
  c: Context,
): AsyncGenerator<T> {
  for await (const event of source) {
    if (event.data?.includes('"service_tier"')) {
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        parsed = undefined
      }
      observeResponseServiceTier(c, parsed)
    }
    yield event
  }
}
