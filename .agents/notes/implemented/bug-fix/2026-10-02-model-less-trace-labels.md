# Agent Note: Identify model-less trace rows by their request path

Status: implemented
Partly-superseded-by: 2026-10-02-llm-only-request-tracing.md

## Problem

The trace feed includes model listing and other API requests without a model. rowModelDisplay renders a dash for these records, making legitimate fast API calls look like unidentified model calls. It also ignores modelRequested when admission has not yet populated model or modelUpstream.

## Decision

Preserve group rendering and the existing model and modelUpstream priority. Fall back to modelRequested, then the recorded HTTP method and path. Keep the dash only when the record has neither a model nor a path.

## Alternatives considered

**Hide every model-less request.** This removes useful API and early-error traces, and hides in-flight requests before routing resolves.

**Guess a model from adjacent requests.** Concurrent requests are independent; a neighboring model cannot identify a model-less call.

## Consequences

The fallback identifies retained generation records whose model has not resolved. The subtitle can still show a dash when there is no upstream connection.

## Superseded

The original decision to retain non-generation requests such as GET /v1/models in the LLM view is replaced by 2026-10-02-llm-only-request-tracing.md. Generation-only admission and historical filtering now remove these records. The modelRequested and request-path display fallback remains valid for early generation snapshots and errors.

## Verification

- `tests/traces-view.test.ts`
- `tests/traces-view.test.ts::model-less trace rows identify the request instead of a dash`

Proved: Added the test before the display change; bun test tests/traces-view.test.ts failed with Expected GET /v1/models, Received -. After the change, all twelve view tests pass, including modelRequested and existing-model precedence checks. The four-file trace and middleware suite reports 41 pass and 0 fail.
