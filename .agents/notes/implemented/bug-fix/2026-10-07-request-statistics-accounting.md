# Agent Note: Preserve request accounting and distinguish snapshots from separate calls

Status: implemented

## Problem

Messages requests without upstream usage and without a local token estimate disappeared from usage counts. Responses streams recorded usage only when a completed or incomplete response was retained, losing failed terminal usage and requests with no terminal response. Daily error counts in `src/lib/log-middleware.ts` inspected HTTP status only, missing protocol failures after an HTTP 200 stream opened.

`src/services/search/orchestrate.ts` added every usage event, including cumulative snapshots within one upstream call. Historical rows with an account ID equal to a credential ID were included in quota-cycle totals but excluded by day, interval and viewer-timezone account filters in `src/lib/stats/queries.ts` and `src/lib/stats/interval.ts`.

## Decision

Keep a zero-token, zero-cost usage row when an attributed Messages or Responses request lacks reported usage and a usable estimate. Retain reported Responses usage on failed terminal events. Keep the existing once-only guards for non-streaming responses returned to streaming callers.

In `src/routes/messages/usage-recorder.ts`, explicit `usage_status: "pending"`
snapshots replace earlier message-start estimates, including with zero counters.
The ordinary positive-count merge remains necessary for providers that send zero
placeholders without this marker. ACP can defer all billable usage until its
tool loop finishes; retaining the opening estimate in those intermediate HTTP
segments charges it again when the final bill arrives.

Count a finalized protocol failure as a daily error even if its HTTP response was 200. Confirmed client cancellations count as requests without increasing server-error counters. Explicit ClientAbortError and native AbortError on an aborted client signal return an empty 499 before error-level logging in `src/lib/error.ts`; internal timeout aborts remain failures. `src/lib/client-abort.ts` holds the shared identity without route/provider dependencies, and `src/lib/request-lifecycle.ts` preserves its existing re-export. Request logs normalize a pre-stream cancelled error to 499/info, while an already-open SSE response keeps its actual wire status. Merge defined usage snapshot fields within each search round and add the final snapshots across distinct rounds. Use the same connection-plus-credential ID set for account filters across usage query variants.

## Alternatives considered

- Estimate missing output tokens from text: this would turn unverified guesses into billing amounts. Zero rows preserve request counts without inventing usage.
- Add all streaming usage events: this counts cumulative snapshots several times. Overwrite the global usage with the latest snapshot: this loses earlier search rounds.
- Migrate all credential-ID rows eagerly: query-time compatibility avoids rewriting historical records and reuses the quota-cycle identity rule.

## Consequences

Requests with unavailable usage remain visible. Their zero cost is not a reconstructed historical charge. Failed streams contribute to errors without changing the HTTP status already sent. Search totals include each target round once. Current credential mappings recover legacy account usage; deleted credential mappings cannot reconstruct ownership of old rows that lack a connection ID.

## Verification

- `tests/usage-recorder.test.ts`
- `tests/log-middleware.test.ts`
- `tests/responses-stream-failure-log.test.ts`
- `tests/search-usage-snapshots.test.ts`
- `tests/quota-cycle-usage.test.ts`

Proved: Before the fixes, the new assertions observed zero instead of one Messages request, zero daily errors for a failed HTTP 200 stream, no Responses usage row for a failed terminal with 15 reported tokens, and 30 instead of 10 input tokens from repeated search snapshots. The account-filter regression observed 0.4 instead of 1.9 cost. Red outputs are retained in ignored temp/stats-audit-red.log and temp/stats-account-red.log. The focused regressions pass after the fixes, including reported and missing failed-response usage and separate search rounds.

Cancellation regression: `tests/log-middleware.test.ts::client cancellation is 499 without server-error logging or counting` covers native and explicit cancellation. The internal-abort control and existing failed-HTTP-200 stream test retain true error accounting. Middleware unit tests disable asynchronous disk persistence; the persistence suite owns that contract.

Proved: Before the cancellation fix, both native and explicit cases returned 500 instead of 499. `.agents/notes-evidence/log-audit-fixes-red.log` retains those failed assertions. The tests now also verify info severity, one request, no error-counter increment, and no error-level stack.

- `tests/usage-recorder.test.ts::pending terminal usage replaces the message-start estimate without charging it`

Proved: the pre-fix recorder persisted 600 input tokens and 0.006 cost despite a
pending zero terminal snapshot. The failing public accounting assertion is saved
in `.agents/notes-evidence/acp-messages-pending-red.log`; the same test passed
after the pending-snapshot exception, alongside the ordinary zero-placeholder
and output-only-delta controls.
