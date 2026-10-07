# Agent Note: Give each CLI bridge layer one responsibility

Status: implemented

## Problem

Both the turn normalizer and the protocol translator filtered internal wait-tool calls and maintained overlapping state. An effort mapping function returned its input unchanged, and the parked resume path repeated its compatibility and finished-state checks.

## Decision

Own internal tool filtering and turn folding in normalizeClaudeTurns. Keep translation responsible for Anthropic output, tool-name conversion and required SSE framing. Pass effort directly to CLI arguments. Check parked compatibility once and let assertAvailable own the finished-state check. Simplify the tool-result content type to the existing prompt-block union.

Require request payloads when constructing or resuming a run. Production always provided them; the empty-policy defaults and missing-payload bypass existed only for tests. Update the test fixtures to supply real request shapes. Let the startup finally block own temporary directory removal instead of deleting the same directory again in the pre-spawn cancellation branch.

Waiting-tool fixtures now await subprocess exit and let the run own temporary directory cleanup. Remove the second fixture deletion and the retry-and-ignore helper that compensated for racing deletions.

## Alternatives considered

Removing cancellation, account isolation, pending-result buffering or SSE completion would remove behavior exercised by existing subprocess and stream regressions. These boundaries remain because they have reproducible failures. Legacy transcript cleanup remains necessary to remove files created before persistence was disabled; explicit HTTP transport remains a supported provider option.

## Consequences

There is one internal-tool filter and fewer pass-through abstractions. Tests exercise filtering through the production normalizer and translator sequence. Existing cancellation, process cleanup, schema error, tool-result race, isolation and SSE completion regressions preserve the useful guards.
