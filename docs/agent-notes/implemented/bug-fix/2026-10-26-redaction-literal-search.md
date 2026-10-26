# Agent Note: Bound known-value redaction work without losing bare-secret protection

Status: implemented

## Problem

`src/lib/redaction/context.ts` scanned the entire input separately for each known value, including values first found in that input. Raising the tenant item limit allowed thousands of distinct emails to block the event loop for seconds. The tenant byte limit was checked while creating mappings, after these expensive scans; it could reject a request only after the CPU cost was paid.

## Decision

Keep bare-value propagation for secrets and independently recognizable personal data. Use `src/lib/redaction/literal-search.ts` to search all known literals with Aho-Corasick when there are more than eight distinct spellings. A fixed small native-search path avoids allocating an index for a single large secret field. Bound trie nodes, matching work and output count independently of tenant storage. Capacity errors become a local 503, never a partially masked upstream payload. Keep contextual identifiers out of bare-value propagation.

The matcher preserves UTF-16 offsets, per-literal non-overlapping occurrences, suffix matches and overlapping literals. The caller still applies HOME boundaries, longest-match precedence, allowlists and category settings. Sorted matches and existing placeholder spans advance monotonically, rather than testing every placeholder against every match. Both text caches remain invalidated by every tenant-entry insertion or deletion through `tenant.version`.

## Alternatives considered

Reducing the caller limit to 1024 again would reject legitimate large requests while retaining the multiplicative scan. Dropping known-value propagation would expose previously identified bare secrets. A single regex alternation would suppress overlapping alternatives needed by boundary checks and longest-match precedence. Copying all suffix outputs into every trie node would move the unbounded growth into the index.

## Consequences

Ordinary matching costs one traversal of the text plus index construction and bounded output handling. Exceptionally large or dense indices fail closed with a local capacity error. The bounds protect this search, not every regular expression or every operation in request handling. Performance tests count full-text searches rather than asserting fragile elapsed-time ratios.

## Verification

- `tests/redaction-kinds.test.ts::large personal batches do not scan the whole text once per known value`
- `tests/redaction-literal-search.test.ts::literal search agrees with independent scans for prefixes, suffixes and UTF-16 offsets`
- `tests/redaction-literal-search.test.ts::literal search rejects excessive output and index size`
- `tests/redaction-literal-search.test.ts::known literals preserve JSON spelling, HOME boundaries and placeholder spans`
- `tests/redaction-literal-search.test.ts::known literal capacity errors reject the request instead of returning partial masking`

Proved: The natural pre-fix run failed the full-text scan assertion with 24000 calls, against a maximum of eight, before the runner also reported its elapsed-time timeout. The same run failed the S3 prefix-offset and German birthday assertions. Output with local filesystem paths removed is saved in `docs/agent-notes-evidence/redaction-literal-search-red.txt`. After the fixes, the focused tests pass, including the 12000-email batch with a live tenant lease and exact restoration.
