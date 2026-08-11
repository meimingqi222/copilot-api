import type { Context } from "hono"

import { HTTPError } from "~/lib/error"
import { safeOrigin, type RequestAdmission } from "~/lib/request-admission"
import { getRequestLogContext, recordUpstreamAttempt } from "~/lib/request-log"

export function recordResponsesWsAttemptIfMissing(
  c: Context,
  admission: RequestAdmission,
  attemptsBefore: number,
  startedAt: number,
  result: {
    status?: number
    errorCode?: string
    errorSnippet?: string
    retryAfterMs?: number
  },
): void {
  const attempts = getRequestLogContext(c)?.entry.attempts?.length ?? 0
  if (attempts > attemptsBefore) return
  const target = admission.target
  recordUpstreamAttempt(
    c,
    {
      connectionId: target.connectionId,
      connectionName: admission.connection.name,
      credentialId: target.credentialId,
      credentialLabel: admission.credential.label,
      endpoint: target.endpoint,
      protocol: target.protocol,
      provider: admission.account?.provider ?? target.protocol,
      upstreamBaseUrl: safeOrigin(admission.connection.baseUrl),
      upstreamModelId: target.upstreamModelId,
      isTranslated: target.isTranslated,
    },
    { ...result, latencyMs: Date.now() - startedAt },
    attempts + 1,
  )
}

export function getResponsesWsErrorSnippet(error: unknown): string {
  if (error instanceof HTTPError) return error.responseBody
  if (error instanceof Error) return error.message
  return String(error)
}

export function getResponsesTerminalOutcome(
  terminal: string,
): "success" | "incomplete" | "failed" {
  if (terminal === "response.completed") return "success"
  if (terminal === "response.incomplete") return "incomplete"
  return "failed"
}
