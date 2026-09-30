import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"

/** One page the search backend reported visiting. */
export interface SearchHit {
  url: string
  title?: string
  pageAge?: string
}

/** What one executed search produced. */
export interface SearchAnswer {
  /** The backend's written answer, if it produced one. */
  text?: string
  hits: Array<SearchHit>
}

/**
 * The account that executes searches on the proxy's behalf, plus the target
 * and model used to call it. Resolved once per request so every round of a
 * loop hits the same upstream.
 */
export interface Searcher {
  connection: ProviderConnection
  credential: ApiCredential
  target: RouteTarget
  /** Public model id used for the search turn. */
  model: string
  /** Lower is preferred (codex accounts first). */
  rank: number
}
