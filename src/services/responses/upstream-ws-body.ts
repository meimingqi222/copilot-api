export type UpstreamWsProvider = "codex" | "xai"

/**
 * Per-provider upstream-socket transport facts.
 *
 * These used to be `if (provider === "codex")` / `if (provider === "xai")`
 * branches scattered across this file and `upstream-ws.ts`, so teaching a third
 * provider to use the upstream socket meant finding every one of them. They are
 * one table now, and `Record<UpstreamWsProvider, …>` turns a new provider into
 * a compile error until it has a row.
 *
 * Upstream sockets are force-closed by the provider after a hard limit, so a
 * fresh connection is dialed *before* it and a turn is never sent on a socket
 * about to be dropped: Codex has a ~60 min hard limit (redial at 55 min), xAI a
 * documented 25 min cap (redial at 24 min). `store: true` (forced for xAI) plus
 * `previous_response_id` keeps multi-turn chaining working across the redial.
 *
 * A stalled socket that accepts `response.create` but never answers would
 * otherwise hang until the downstream client gives up; `firstEventTimeoutMs`
 * turns that into a transport error *before* the stream is returned, so the
 * caller can fall back to HTTP POST (which has no WS frame limit).
 *
 * Deliberately NOT on `ProviderModule`: the responses layer cannot read the
 * provider registry, because the registry already reaches this module through
 * `providers → modules/codex → protocols/codex-native →
 * codex/create-responses-once → upstream-ws`. Reading the profile from the
 * module would close that cycle around the transport layer.
 */
interface UpstreamWsTransportProfile {
  /** Proactive redial age for a pooled socket. */
  maxSocketAgeMs: number
  /** Max wait for the first upstream event after `response.create`. */
  firstEventTimeoutMs: number
  /**
   * Keep provider-finalized `stream_options` on the `response.create` frame.
   * Codex filters them at its outbound boundary; xAI strips them entirely.
   */
  keepStreamOptions: boolean
  /** Force `store: true`, and drop `instructions` when chaining a turn. */
  storeChainedTurns: boolean
  /** Upstream terminal event type to rewrite before downstream consumers. */
  terminalAlias?: { from: string; to: string }
}

const UPSTREAM_WS_PROFILES: Record<
  UpstreamWsProvider,
  UpstreamWsTransportProfile
> = {
  codex: {
    maxSocketAgeMs: 55 * 60_000,
    firstEventTimeoutMs: 60_000,
    keepStreamOptions: true,
    storeChainedTurns: false,
    terminalAlias: { from: "response.done", to: "response.completed" },
  },
  xai: {
    maxSocketAgeMs: 24 * 60_000,
    firstEventTimeoutMs: 60_000,
    keepStreamOptions: false,
    storeChainedTurns: true,
  },
}

export function upstreamWsProfile(
  provider: UpstreamWsProvider,
): UpstreamWsTransportProfile {
  return UPSTREAM_WS_PROFILES[provider]
}

/** Build the wire JSON for `response.create` on the upstream WS. */
export function buildUpstreamResponsesCreateBody(
  body: Record<string, unknown>,
  options: { provider: UpstreamWsProvider },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, type: "response.create" }
  delete out.stream
  delete out.background

  const profile = upstreamWsProfile(options.provider)
  if (!profile.keepStreamOptions) {
    delete out.stream_options
  }

  if (profile.storeChainedTurns) {
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
  const alias = upstreamWsProfile(provider).terminalAlias
  if (alias && event.type === alias.from) {
    event.type = alias.to
  }
  return typeof event.type === "string" ? event.type : ""
}
