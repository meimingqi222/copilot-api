# Agent Note: Complete provider performance boundaries

Status: implemented

## Problem

The performance route's TTL cache survives usage mutations and test database
resets, returning previous records. Large percentile aggregations block the
request event loop. Quota dirty detection omits refreshed credential context
and exhaustedAt. Dump file caching accepts a parent-directory prefix as an
exact match; the JSON prefilter skips long leading whitespace. Awaiting a
cloned request stream's cancellation can wait for its unread original branch.
ZCode cold probes need shared timeouts and independently cancellable waiters.

## Decision

Invalidate performance cache by successful usage writes and database resets;
share one read and aggregation promise per range and discard rejected jobs.
Large aggregations run in a bounded worker queue; small ranges stay local.
Compare the complete serialized connection before deciding whether to persist
quota refreshes, and keep four workers busy independently of slow connections.
Match dump directory and date exactly; preserve valid whitespace-prefixed JSON;
stop retaining chunks at the size limit and cancel the cloned stream without
awaiting the original branch. ZCode probes share a 15s timeout, retain stale
routes during refresh, and allow individual request cancellation.

## Alternatives considered

**TTL alone.** It returns stale data immediately after writes and resets.

**Partial quota fingerprints.** They can silently drop refreshed auth state.

**Synchronous large aggregation.** It stalls chat processing during percentile
sorting; the worker has bounded pending jobs to prevent unbounded queues.

## Consequences

Provider protocol lookup now comes from one pure definition module. The unused central L1 cache capability table is removed; native cache
behavior stays in provider services and shared L0 defaults need no per-provider
registration.
Unused descriptor aliases and internal exports are removed. A cold ZCode
request still waits for the shared probe to preserve correct plan selection;
subsequent stale-cache requests refresh without waiting. SQLite range reads
and row serialization remain on the main thread, but expensive sorting is
performed off thread. Worker failures propagate and evict the failed cache.

## Verification

- `tests/admin-performance.test.ts`
- `tests/request-dump.test.ts`
- `tests/oauth-zcode.test.ts`
- `tests/quota-refresh.test.ts`
- `tests/session-affinity.test.ts`
- `tests/provider-cache-defaults.test.ts`
- `tests/performance-worker.test.ts`

Proved: temp/perf-red-proof.py temporarily removed revision matching, restored
partial quota fingerprints, changed exact directory matching to startsWith,
and restored the 64-character JSON prefilter. The new cache, context-change,
rotation-directory, and long-whitespace redaction tests all failed (exit 1,
temp/perf-red-proof.log); the script restored every source file in finally.
The three previously failing admin performance tests also passed after the
revision invalidation fix. Focused tests exercise real worker computation,
20 shared ZCode calls, caller cancellation, timeout, stale refresh, streaming
body overflow without waiting for the original branch, and quota worker reuse.
