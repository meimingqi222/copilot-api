/**
 * Canonical path table for the LLM-facing endpoints.
 *
 * Both consumers read this one table, so they cannot drift apart the way the
 * previous `isLlmRequest` / `isCoreApiPath` pair did:
 *
 * - `trace` (see `isLlmRequest`): real inference calls, recorded in the
 *   request log and published on the trace bus. Cheap side endpoints (token
 *   counting, embeddings) are excluded — they would only add noise.
 * - `dump` (see `shouldDumpRequest`): requests worth writing a raw request
 *   dump for while troubleshooting. A strict superset of `trace`: it also
 *   covers the side endpoints, and must never silently miss a wire the trace
 *   set covers.
 *
 * Sub-paths are enumerated rather than matched with `startsWith`, so a
 * path-traversal such as `/v1/chat/completions/../../.env` cannot match.
 */
interface LlmPathSpec {
  path: string
  /** Record as an inference trace, and therefore in the request log. */
  trace: boolean
}

const LLM_PATHS: ReadonlyArray<LlmPathSpec> = [
  { path: "/chat/completions", trace: true },
  { path: "/v1/chat/completions", trace: true },
  { path: "/v1/messages", trace: true },
  // Token counting is cheap and non-generative: dumpable, never traced.
  { path: "/v1/messages/count_tokens", trace: false },
  { path: "/responses", trace: true },
  { path: "/v1/responses", trace: true },
  { path: "/responses/compact", trace: true },
  { path: "/v1/responses/compact", trace: true },
  // Embeddings are likewise dumpable but not a generation trace.
  { path: "/embeddings", trace: false },
  { path: "/v1/embeddings", trace: false },
]

/** Gemini selects the operation in the method name, not a body field. */
const GEMINI_GENERATE_PATH =
  /^\/v1beta\/models\/.+:(?:generateContent|streamGenerateContent)$/

const TRACE_PATHS = new Set(
  LLM_PATHS.filter((entry) => entry.trace).map((entry) => entry.path),
)
const DUMP_PATHS = new Set(LLM_PATHS.map((entry) => entry.path))

/** Only the Responses endpoint has a WebSocket form. */
const RESPONSES_PATHS = new Set(["/responses", "/v1/responses"])

/** Methods whose body is worth dumping once the dump switch is on. */
const DUMP_METHODS = new Set(["PATCH", "POST", "PUT"])

export function isLlmRequest(request: {
  method?: string
  path?: string
}): boolean {
  const { method, path } = request
  if (!path) return false
  if (method === "WS") return RESPONSES_PATHS.has(path)
  if (method !== undefined && method !== "POST") return false
  return TRACE_PATHS.has(path) || GEMINI_GENERATE_PATH.test(path)
}

/**
 * Whether an incoming request should be written to the request dump
 * (`DUMP_REQUESTS=1`). Covers everything `isLlmRequest` covers plus the cheap
 * side endpoints, and matches paths exactly rather than by prefix.
 */
export function shouldDumpRequest(request: {
  method?: string
  path?: string
}): boolean {
  const { method, path } = request
  if (!path) return false
  if (method !== undefined && !DUMP_METHODS.has(method)) return false
  return DUMP_PATHS.has(path) || GEMINI_GENERATE_PATH.test(path)
}
