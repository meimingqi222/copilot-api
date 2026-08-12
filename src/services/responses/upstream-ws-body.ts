export type UpstreamWsProvider = "codex" | "xai"

/** Build the wire JSON for `response.create` on the upstream WS. */
export function buildUpstreamResponsesCreateBody(
  body: Record<string, unknown>,
  options: { provider: UpstreamWsProvider },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, type: "response.create" }
  delete out.stream
  delete out.background

  // Codex WS keeps stream_options (CPA does not strip them on the WS path):
  // reasoning_summary_delivery controls visible thinking, and include_usage
  // is what makes the upstream attach `usage` to response.completed (without
  // it usage_stats / performance monitoring records nothing for the turn).
  // xAI WS strips stream_options entirely (CPA parity).
  const streamOptions = getRecord(out.stream_options)
  const reasoningSummaryDelivery = streamOptions?.reasoning_summary_delivery
  const includeUsage = streamOptions?.include_usage
  delete out.stream_options
  if (options.provider === "codex") {
    const kept: Record<string, unknown> = {}
    if (reasoningSummaryDelivery !== undefined) {
      kept.reasoning_summary_delivery = reasoningSummaryDelivery
    }
    if (includeUsage !== undefined) {
      kept.include_usage = includeUsage
    }
    if (Object.keys(kept).length > 0) {
      out.stream_options = kept
    }
  }

  if (options.provider === "xai") {
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

/** Normalize provider-specific terminal aliases before downstream consumers. */
export function normalizeUpstreamWsEvent(
  event: Record<string, unknown>,
  provider: UpstreamWsProvider,
): string {
  if (provider === "codex" && event.type === "response.done") {
    event.type = "response.completed"
  }
  return typeof event.type === "string" ? event.type : ""
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}
