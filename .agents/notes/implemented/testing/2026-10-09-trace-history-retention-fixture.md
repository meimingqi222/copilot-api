# Agent Note: Trace history fixture stays within retention

Status: implemented

## Problem

The history merge test used a fixed October 1 log file. As wall-clock time moved
past the seven-day retention window, delayed request-log appends from earlier
tests could trigger cleanup and delete that fixture during its read. The queue
full-suite run reproduced ENOENT while the isolated history test passed.

## Decision

Use a timestamp one minute before the test starts and derive its UTC log filename
from that timestamp. Retain the narrow query window and all merge, deduplication
and persistence assertions in `tests/admin-trace.test.ts`.

## Alternatives considered

Increasing production retention or disabling cleanup would hide the fixture bug.
A fixed future date would drift again and would not represent normal history.

## Consequences

The test remains inside the default retention window and independent of delayed
cleanup. Production logging behavior is unchanged. The original failing full run
is recorded in ignored temp/concurrency-audit/queue-full-suite.log.
