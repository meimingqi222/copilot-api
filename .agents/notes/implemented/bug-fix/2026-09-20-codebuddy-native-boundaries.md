# Agent Note: CodeBuddy native boundary correctness and bounded aggregation

Status: implemented

## Problem

CodeBuddy's native adapter treated configured request-header names as
case-sensitive even though HTTP header names are not. A lower-case `x-domain`
or `x-user-id` could coexist with the adapter's title-case default; converting
that record to Fetch headers joined both values with a comma and sent an
invalid identity header. The same adapter only removed empty SSE placeholders
from the first choice, so multi-choice streams retained fields that repeatedly
switched client renderers between thinking and content states.

The forced-streaming-to-non-streaming aggregator also stored tool calls at
their upstream numeric index in an array. A large or discontinuous index made
the final compaction scan the entire sparse array. Finally, refreshed opaque
access tokens ignored the upstream `expiresIn`, causing every subsequent
request to refresh again because no JWT `exp` could be decoded.

## Decision

CodeBuddy request headers are assembled with the Fetch `Headers` abstraction,
so configured values replace defaults case-insensitively while the credential
still owns `Authorization`. Manual `X-User-Id` values are also honored during
token refresh. SSE placeholder cleanup iterates every choice.

The shared SSE aggregator stores tool calls in a `Map` keyed by validated
non-negative integer index, then sorts the small set of actual calls at output
time. Token refresh derives expiry from JWT `exp` first and falls back to a
finite positive `expiresIn`. Concurrent refresh remains connection-deduplicated;
an individual request abort only stops that caller's wait and cannot cancel a
refresh shared by other callers. Disabled connections and credentials do not
schedule refresh timers.

Header lookup/normalization is centralized: `setHeader`/`removeHeader`/`getHeader`
(`services/protocols/shared.ts`) are the only case-insensitive header helpers,
and `resolveCodebuddyDomain` is exported from `services/codebuddy/token-refresh.ts`
and reused by the adapter, so the two consumers cannot drift on the default.

## Alternatives considered

**Keep plain header records and remove duplicate keys manually.** This is easy
to regress whenever another custom header is introduced, because JavaScript
object keys remain case-sensitive. `Headers.set` directly implements the wire
contract and keeps the override order explicit.

**Compact an index-addressed array with `filter`.** This removes `null` holes
from serialized output but still performs work proportional to the largest
untrusted index rather than the number of tool calls. A `Map` keeps merge cost
proportional to actual deltas.

**Attach the first caller's abort signal to the deduplicated refresh fetch.**
That lets one disconnected request abort authentication work needed by every
other concurrent request. The shared refresh continues while each caller can
independently cancel its wait.

## Consequences

Header construction performs one native `Headers` normalization per upstream
request (CodeBuddy) or an O(n) case-insensitive rebuild over the small
connection-header record (shared adapters). Non-streaming tool-call output
performs an O(k log k) sort for k actual calls instead of an O(maxIndex)
sparse-array scan; ordinary contiguous indexes retain their ordering. The
refresh fallback assumes CodeBuddy's `expiresIn` is measured in seconds,
matching the response contract. If a refresh returns neither a decodable JWT
`exp` nor a positive `expiresIn`, the credential still reads as needing a
refresh and every request re-refreshes (pre-existing; this change does not
close that gap).

## Verification

- `tests/codebuddy-provider.test.ts` — `applies custom headers case-insensitively without combining duplicates`, `uses expiresIn when a refreshed access token has no JWT expiry`
- `tests/codebuddy-stream-sanitize.test.ts` — `sanitizes every choice in a multi-choice chunk`, `empty reasoning alias placeholders are stripped, real text kept`
- `tests/sse-aggregate.test.ts` — `handles a very large tool_call index without allocating a sparse array`

The verifier's anchor grammar cannot carry a space, so the test paths are
cited bare and each exact test name is spelled out above and in the `Proved:`
line.

Proved: temporarily restored duplicate header appending, first-choice-only SSE
cleanup, and omission of the `expiresIn` fallback; the three bound CodeBuddy
tests failed with a comma-joined `x-domain`, untouched second-choice fields,
and an undefined expiry respectively (`bun test tests/codebuddy-provider.test.ts tests/codebuddy-stream-sanitize.test.ts`, 3 failures), then the regressions were reverted and the full suite passed.
