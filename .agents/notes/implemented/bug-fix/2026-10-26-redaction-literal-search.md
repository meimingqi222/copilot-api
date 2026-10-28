# Agent Note: Bound known-value redaction work without losing bare-secret protection

Status: implemented

## Problem

`src/lib/redaction/context.ts` scanned the entire input separately for each known value, including values first found in that input. Raising the tenant item limit allowed thousands of distinct emails to block the event loop for seconds. The tenant byte limit was checked while creating mappings, after these expensive scans; it could reject a request only after the CPU cost was paid.

The trie path also had two capacity cliffs that did not match the work it protected. Nine short values over an 8 MB body took the trie path and failed while eight passed, because the native fast path was chosen by value count. Nine 30 KB secrets made every later request fail even when the text was short: the trie node budget was consumed by the session's cumulative secret length, which `evictUnused` never shrinks.

## Decision

Keep bare-value propagation for secrets and independently recognizable personal data. Use `src/lib/redaction/literal-search.ts` to search known literals with Aho-Corasick when native substring search would exceed its work budget. The native path is chosen by `text.length * values.size`, not by a fixed value count: it covers a handful of very long secrets and a large value set over a short body, where building a 100 MB trie is the expensive part. Before building the trie, reject a scan whose text plus literal length cannot fit the work budget. Bound trie nodes, matching work and output count independently of tenant storage. Capacity errors become a local 503, never a partially masked upstream payload. Keep contextual identifiers out of bare-value propagation.

The matcher preserves UTF-16 offsets, per-literal non-overlapping occurrences, suffix matches and overlapping literals. The caller still applies HOME boundaries, longest-match precedence, allowlists and category settings. A rejected candidate does not consume the output budget; only matches the caller accepts count toward it. Sorted matches and existing placeholder spans advance monotonically, rather than testing every placeholder against every match. Both text caches remain invalidated by every tenant-entry insertion or deletion through `tenant.version`.

## Alternatives considered

Reducing the caller limit to 1024 again would reject legitimate large requests while retaining the multiplicative scan. Dropping known-value propagation would expose previously identified bare secrets. A single regex alternation would suppress overlapping alternatives needed by boundary checks and longest-match precedence. Copying all suffix outputs into every trie node would move the unbounded growth into the index. Raising the trie node cap or keeping the eight-value cutoff would only move the cliff: nine 30 KB secrets would still build a 270K-node index before the text was scanned.

## Consequences

Ordinary matching costs one traversal of the text plus index construction and bounded output handling. The native path is bounded by estimated work rather than value count, so adding one short secret no longer changes which path runs. A rejected HOME candidate does not consume the output budget. Exceptionally large or dense indices fail closed with a local capacity error. The bounds protect this search, not every regular expression or every operation in request handling. Performance tests count full-text searches rather than asserting fragile elapsed-time ratios.

## Verification

- `tests/redaction-kinds.test.ts::large personal batches do not scan the whole text once per known value`
- `tests/redaction-literal-search.test.ts::literal search agrees with independent scans for prefixes, suffixes and UTF-16 offsets`
- `tests/redaction-literal-search.test.ts::literal search rejects excessive output`
- `tests/redaction-literal-search.test.ts::small value sets with long literals use the native fallback`
- `tests/redaction-literal-search.test.ts::nine values over a large text stay on the native path`
- `tests/redaction-literal-search.test.ts::rejected candidates do not consume the match budget`
- `tests/redaction-literal-search.test.ts::nine long secrets in one session do not stick a 503 on later requests`
- `tests/redaction-literal-search.test.ts::known literals preserve JSON spelling, HOME boundaries and placeholder spans`
- `tests/redaction-literal-search.test.ts::known literal capacity errors reject the request instead of returning partial masking`

Proved: The natural pre-fix run failed the full-text scan assertion with 24000 calls, against a maximum of eight, before the runner also reported its elapsed-time timeout. The same run failed the S3 prefix-offset and German birthday assertions. Output with local filesystem paths removed is saved in `.agents/notes-evidence/redaction-literal-search-red.txt`. After the fixes, the focused tests pass, including the 12000-email batch with a live tenant lease and exact restoration.
