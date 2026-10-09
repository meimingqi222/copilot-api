# Agent Note: Name a summary bucket only when it has one connection identity

Status: implemented

## Problem

`src/lib/stats/provider-labels.ts` counted distinct available names instead of
actual connection identities. A protocol summary containing a live connection
and deleted or unnamed historical connections was labeled as the live upstream,
even though its totals included the others. Two different same-named connections
were also incorrectly treated as one upstream.

## Decision

Count unique connection IDs including deleted and unnamed IDs. Name the summary
only when exactly one ID remains and that connection is live and named. Otherwise
use the protocol label. Keep all totals and nested account rows intact.

## Alternatives considered

Discarding deleted rows would corrupt historical accounting. Counting only live
names recreates the bug. Splitting the summary by connection would change its
existing response contract; performance buckets already provide that view.

## Consequences

Mixed historical buckets remain neutral, even if all surviving names are equal.
Single live-connection summaries still show their upstream name. The change is
presentation-only and does not affect pricing, routing or recorded provider IDs.

## Verification

- `tests/admin-performance.test.ts::usage summary keeps mixed upstreams unattributed`
- `tests/admin-performance.test.ts::usage summary names the single upstream behind a compatible protocol`

Proved: the pre-fix integration run labeled deleted, unnamed and same-name mixed buckets as DeepSeek; evidence is `.agents/notes-evidence/recent-commit-regressions-red.log`. The same cases passed after the fix with both requests and nested account rows preserved.
