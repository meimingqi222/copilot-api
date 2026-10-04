# Agent Note: Redact incoming and failed upstream dumps before disk writes

Status: implemented

## Problem

Request dumps only masked five credential header names. JSON bodies, string-encoded tool arguments, media data, additional provider authentication headers and failed upstream error echoes were written verbatim. Truncating a raw body could persist part of a secret without a complete JSON field available for redaction.

## Decision

Both dump paths sanitize their disk copies before queueing an append. Detect credential field names without masking token counters or ordinary metadata. Recursively process JSON strings, share known credential values across a request's body and error echoes, scrub recognizable authentication text, and omit inline media. Invalid JSON request bodies and oversized incoming bodies are omitted rather than saved as raw prefixes. Upstream fields are sanitized before UTF-8 byte truncation, retaining original byte counts. Forwarded requests remain unchanged.

## Alternatives considered

**Only add more header names.** This leaves credentials in body fields, tool arguments and upstream errors exposed.

**Reuse the diagnostic snippet sanitizer.** Its broad data/token field matching drops useful protocol metadata and token counters, and it does not recurse into string-encoded tool arguments.

**Remove all prompt and tool content.** This loses the transcript and parameter information the diagnostic setting is intended to compare. Ordinary content remains, with this limitation stated in the settings UI and documentation.

## Consequences

Redaction is automatic whenever dumps are enabled. It changes dump formatting and is not a general anonymizer for arbitrary personal data or unlabeled secrets in prose. The existing sensitive-data acknowledgement remains appropriate. Historical dumps are not rewritten. Request forwarding and provider credentials are not modified.

## Verification

- `tests/request-dump.test.ts`

Proved: before the implementation, bun test tests/request-dump.test.ts failed four assertions (8 pass, 4 fail, temp/request-dump-red.log), including secrets present in incoming and upstream files and raw-prefix truncation. The restored implementation passes tests that inspect actual disk output, retain ordinary values, confirm forwarded bodies are unchanged and bound UTF-8 output bytes.
