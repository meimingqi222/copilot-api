# Agent Note: Normalize the default Anthropic discovery version once

Status: implemented

## Problem

`src/services/protocols/anthropic-compatible.ts` defaulted discovery to
`/v1/models`. The URL helper appends explicitly versioned paths verbatim, so a
base already ending in `/v1` produced `/v1/v1/models`. Existing tests supplied
an explicit `/models` override and did not cover the default.

## Decision

Default to `/models` and let the existing URL helper inject `/v1` only when the
base lacks a version. Preserve explicitly configured relative and absolute
discovery endpoints, credential headers, connection proxies and cancellation.

## Alternatives considered

Globally stripping duplicate version segments in the URL helper would change
explicit endpoint contracts across protocols. Special-casing Kimi domains would
not fix other Anthropic-compatible providers. Neither is necessary.

## Consequences

Both root and versioned bases work, including nested `/coding` paths and trailing
slashes. No request/response translation or generation behavior changes.

## Verification

- `tests/connection-proxy-wiring.test.ts::default discovery normalizes the version for`
- `tests/connection-proxy-wiring.test.ts::explicit discovery endpoint remains authoritative`

Proved: the pre-fix run failed the two versioned-base URL assertions with duplicated `/v1`; evidence is `.agents/notes-evidence/recent-commit-regressions-red.log`. All default and explicit discovery cases passed after the fix.
