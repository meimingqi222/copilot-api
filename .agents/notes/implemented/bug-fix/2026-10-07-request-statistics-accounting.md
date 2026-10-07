# Agent Note: Preserve request accounting and distinguish snapshots from separate calls

Status: implemented

## Problem

Messages requests without upstream usage and without a local token estimate disappeared from usage counts. Responses streams recorded usage only when a completed or incomplete response was retained, losing failed terminal usage and requests with no terminal response. Daily error counts in `src/lib/log-middleware.ts` inspected HTTP status only, missing protocol failures after an HTTP 200 stream opened.

`src/services/search/orchestrate.ts` added every usage event, including cumulative snapshots within one upstream call. Historical rows with an account ID equal to a credential ID were included in quota-cycle totals but excluded by day, interval and viewer-timezone account filters in `src/lib/stats/queries.ts` and `src/lib/stats/interval.ts`.

## Decision

Keep a zero-token, zero-cost usage row when an attributed Messages or Responses request lacks reported usage and a usable estimate. Retain reported Responses usage on failed terminal events. Keep the existing once-only guards for non-streaming responses returned to streaming callers.

Count a finalized protocol failure as a daily error even if its HTTP response was 200. Merge defined usage snapshot fields within each search round and add the final snapshots across distinct rounds. Use the same connection-plus-credential ID set for account filters across usage query variants.

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
