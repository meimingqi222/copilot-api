/**
 * Picks the account that executes web searches on the proxy's behalf.
 */

import type {
  ModelEndpoint,
  ModelMapping,
  ProviderConnection,
  ProviderProtocol,
  RouteTarget,
} from "~/lib/provider-connections"

import {
  getConnectionRoutability,
  isCredentialAvailable,
  listProviderConnections,
  refreshConnectionAvailability,
} from "~/lib/provider-connections"

import type { Searcher } from "./types"

/** Protocol → the endpoint its native search tool rides on. */
const SEARCH_PROTOCOLS: ReadonlyArray<{
  protocol: ProviderProtocol
  endpoint: ModelEndpoint
  rank: number
}> = [
  { protocol: "codex-native", endpoint: "responses", rank: 0 },
  { protocol: "claude-native", endpoint: "messages", rank: 1 },
  { protocol: "anthropic-compatible", endpoint: "messages", rank: 2 },
  { protocol: "openai-responses-compatible", endpoint: "responses", rank: 3 },
]

/** Names that usually mark the cheapest tier of a model family. */
const SMALL_MODEL = /(mini|flash|haiku|small|nano|lite)/i

export function searchOrchestrationEnabled(): boolean {
  return process.env.SEARCH_ORCHESTRATION !== "0"
}

interface SearcherPolicy {
  protocol: ProviderProtocol
  endpoint: ModelEndpoint
  rank: number
}

function policyFor(protocol: ProviderProtocol): SearcherPolicy | undefined {
  return SEARCH_PROTOCOLS.find((entry) => entry.protocol === protocol)
}

/**
 * First enabled model on `connection` that can serve `endpoint`, preferring a
 * small tier. Returns `undefined` when the connection has nothing usable.
 */
function pickModel(
  connection: ProviderConnection,
  endpoint: ModelEndpoint,
): ModelMapping | undefined {
  const usable = (connection.models ?? []).filter(
    (model) => model.enabled && model.endpoints.includes(endpoint),
  )
  if (usable.length === 0) return undefined
  return (
    usable.find((model) => SMALL_MODEL.test(model.publicId))
    ?? usable.find((model) => SMALL_MODEL.test(model.upstreamId))
    ?? usable[0]
  )
}

/** Minimal RouteTarget — mirrors `modelToTestTarget` in the admin helpers. */
function toTarget(
  connection: ProviderConnection,
  endpoint: ModelEndpoint,
  model: ModelMapping,
): RouteTarget {
  return {
    connectionId: connection.id,
    connectionName: connection.name,
    protocol: connection.protocol,
    credentialId: "",
    publicModelId: model.publicId,
    upstreamModelId: model.upstreamId,
    endpoint,
    connectionPriority: connection.priority,
    connectionWeight: connection.weight ?? 1,
    credentialPriority: 0,
    credentialWeight: 1,
  }
}

/**
 * Resolves the ranked searcher list, most preferred first.
 *
 * Pure read: callers decide whether to use any of them (`planTranslation` must
 * stay side-effect free, so availability is checked here by the caller).
 */
function listSearcherCandidates(): Array<Searcher> {
  const out: Array<Searcher> = []
  for (const connection of listProviderConnections()) {
    const policy = policyFor(connection.protocol)
    if (!policy) continue
    // Expired cooldowns/quota must be restored before judging routability.
    refreshConnectionAvailability(connection)
    if (!getConnectionRoutability(connection).routable) continue
    const credential = connection.credentials.find(isCredentialAvailable)
    if (!credential) continue
    const model = pickModel(connection, policy.endpoint)
    if (!model) continue
    out.push({
      connection,
      credential,
      target: toTarget(connection, policy.endpoint, model),
      model: model.publicId,
      rank: policy.rank,
    })
  }
  return out.sort((a, b) => a.rank - b.rank)
}

/** `true` when at least one account could execute a search right now. */
export function hasSearcher(): boolean {
  return searchOrchestrationEnabled() && listSearcherCandidates().length > 0
}

/**
 * Ranked searcher list, or an empty array when orchestration is switched off.
 * Callers iterate it so a failing searcher falls through to the next one.
 */
export function listSearchers(): Array<Searcher> {
  if (!searchOrchestrationEnabled()) return []
  return listSearcherCandidates()
}

export function describeSearcher(searcher: Searcher): string {
  return `${searcher.connection.id}/${searcher.model} (${searcher.connection.protocol})`
}
