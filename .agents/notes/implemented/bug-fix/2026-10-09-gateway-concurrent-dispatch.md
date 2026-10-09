# Agent Note: Route concurrent turns to available capacity before pacing

Status: implemented
Partly-superseded-by: 2026-10-09-bounded-concurrency-queue.md

## Problem

Equal-quota requests concentrated on the first connection, waiting for pacing before discovering a saturated credential and repeating the wait on fallback. TimeoutError during local pacing could cool a healthy upstream. Body reads allocated 64 KiB even for tiny requests, and synchronous statistics used a rollback journal.

## Decision

Share reserved/active counts between routing and dispatch in lib/route-target/load. Preserve endpoint tiers, quota bands and healthy session affinity. Prefer available lanes before connection priority; on equal fine-band quota ranks prefer the less busy lane. When all lanes are full retain a saturated candidate for dispatch admission; bounded queuing now owns the all-full behavior. Reserve before pacing, release on cancellation/failure or completed stream consumption, and do not cool an upstream when the caller signal is aborted, including TimeoutError.

Body reads retain a single chunk without copying and allocate bounded geometric buffers only for subsequent chunks. File statistics use WAL with the existing durability setting; in-memory databases remain in memory.

## Alternatives considered

Removing caps or pacing loses upstream protection without fixing routing concentration. Globally switching to round-robin discards quota/renewal preferences. Ignoring affinity harms cache reuse. Keeping arbitrary tiny chunks forever exposes metadata overhead. Relaxing SQLite synchronous durability is unnecessary.

## Consequences

Pacing reservations count toward the existing cap. A saturated primary may use an available backup, and all-full enters the bounded queue described by the successor. WAL uses SQLite sidecars: live copies require a consistent SQLite backup/checkpoint. Large request objects and serialized wire bodies still consume memory; no global body memory budget is introduced.

## Superseded

The all-full immediate-429 behavior is replaced by the bounded concurrency queue.
Capacity-aware routing, reservation before pacing, cancellation handling, body
allocation and WAL decisions remain in force. The immediate-rejection regression
now explicitly disables queuing to verify that configured mode.

## Verification

Test files: `tests/routing-quota.test.ts`, `tests/dispatch-credential-lease.test.ts`,
`tests/request-body.test.ts`, `tests/stats-wal.test.ts`.

- `tests/routing-quota.test.ts::uses an idle equally ranked connection while the first is serving a turn`
- `tests/routing-quota.test.ts::uses an available backup instead of waiting on a saturated primary`
- `tests/routing-quota.test.ts::keeps a healthy session binding even when an equally ranked lane is idle`
- `tests/dispatch-credential-lease.test.ts::rejects a saturated credential before waiting for its pacing lock`
- `tests/dispatch-credential-lease.test.ts::releases its reserved slot when cancelled during pacing`
- `tests/request-body.test.ts::retains a single body chunk without allocating another large buffer`
- `tests/request-body.test.ts::keeps split UTF-8 text intact across empty and small chunks`
- `tests/stats-wal.test.ts::file-backed statistics use WAL while another reader has a snapshot open`

Proved: Before the fix, idle/backup routing, buffer identity and WAL assertions failed in temp/concurrency-audit/optimization-red.log; saturated pacing returned TimeoutError in pacing-order-red.log; cancelled pacing wrote cooldownUntil in pacing-cancel-red.log. All now pass with existing streaming lease/pacing coverage. Evidence stays in ignored temp.
