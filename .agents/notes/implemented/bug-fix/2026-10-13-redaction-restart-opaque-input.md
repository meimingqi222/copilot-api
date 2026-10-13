# Agent Note: Preserve opaque redaction placeholders after restart

Status: implemented

## Problem

`src/lib/redaction/context.ts` keeps caller-specific redaction mappings in memory. A process restart, idle expiry or capacity eviction loses these mappings. Replaying ordinary input containing a SECRET, HOME or WORD placeholder then returns a local 422 before reaching the upstream. The same syntax can also originate in another tool, so its presence does not prove ownership by this proxy.

## Decision

Treat unknown placeholders in ordinary text as opaque input. Preserve their spans so overlapping redaction rules cannot rewrite them. Only known entries in the current caller's tenant enter the request's restoration allowlist. New sensitive input continues to be masked. Signed content still follows the existing exact-content and issuer checks.

## Alternatives considered

**Persist every original value.** This expands sensitive data retention and still does not resolve placeholders produced by other tools. It is unnecessary to forward already-redacted ordinary text.

**Require original input after every restart.** This makes normal service lifecycle events break existing client conversations.

**Search other callers for a mapping.** This violates caller isolation and can disclose another user's original values.

## Consequences

Unknown placeholders remain visible as placeholders; lost originals cannot be reconstructed. This fix removes the ordinary-text 422, rather than promising durable original-value restoration or recovery of signed replay history. Caller isolation, bounded memory and signature validation remain in force.

## Verification

- `tests/redaction-restart.test.ts::ordinary placeholders survive a real process restart without restoring another caller's values`
- `tests/upstream-redaction.test.ts::expired ordinary placeholders remain opaque while new sensitive input is still masked`
- `tests/upstream-redaction-routes.test.ts`

Proved: Before the implementation change, `bun test tests/redaction-restart.test.ts` failed in the second independent Bun process with the exact local 422 message "Redaction context expired or belongs to another caller; replay original input". After the change the test passes for SECRET, HOME and WORD input and both JSON and stream restoration. Expiry, eviction, caller isolation and Responses HTTP JSON/SSE tests also pass.
