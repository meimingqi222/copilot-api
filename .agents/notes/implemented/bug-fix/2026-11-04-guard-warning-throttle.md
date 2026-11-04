# Agent Note: Throttle guard warnings before calling the shared logger

Status: implemented

## Problem

A proxy IP can accumulate abuse signals from many callers. With automatic
blocking disabled, every subsequent request repeated the same warning and
drowned out other failures, even though the guard snapshot was still useful.

## Decision

`src/lib/client-guard/abuse-scoring.ts` emits the first eligible warning, then
at most one per snapshot every five minutes unless its score rises. Another IP
has an independent window. Reason changes alone do not restart the window.
A WeakMap follows the existing snapshot lifetime instead of retaining IPs.

Rate-limit at this decision point, before the logger call. Do not restore the
shared logger's deferred batching: its separate request/job correlation contract
requires synchronous reporting. Continue all scoring, request previews and
manual blacklist behavior; do not enable automatic IP blocking.

## Alternatives considered

Global logger batching loses async request/job attribution. Silencing all guard
warnings hides new incidents and escalation. An unbounded map keyed by IP keeps
expired clients alive after the snapshot tracker has already pruned them.

## Consequences

Repeated requests remain visible in guard counters but do not each create a
warning. Escalation and periodic reminders remain visible. Proxy header trust
and client IP selection are unchanged.

## Verification

- `tests/guard.test.ts::throttles repeated IP warnings while retaining escalation, other IPs and periodic reminders`

Proved: Before the fix, 100 calls emitted 100 warnings where the assertion
expected one. `.agents/notes-evidence/log-audit-fixes-red.log` retains that run.
The test passes with per-snapshot throttling, including escalation, another IP,
the five-minute boundary and the no-auto-block control.
