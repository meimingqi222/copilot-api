# Agent Note: Normalize Windsurf tool snapshots before emitting Chat deltas

Status: implemented

## Problem

Windsurf frames can repeat a tool call's ID and name, with growing argument
snapshots rather than just new argument bytes. Allocating an index per repeated
header produces duplicate tools; appending snapshots produces invalid JSON.
Frames carrying an ID and arguments but no name also lost their ID during
parsing, sending interleaved arguments to the wrong tool.

## Decision

`src/services/windsurf/response-parsers.ts` preserves argument call IDs
independently of whether the frame includes a name.
`src/services/windsurf/create-chat-completions.ts` allocates each ID's index once
and keeps its accumulated arguments. If incoming arguments start with that
accumulation, only the new suffix is emitted; otherwise the incoming bytes are
an incremental chunk and are appended unchanged. Equal snapshots emit nothing.
Explicit IDs select the call; ID-less continuations follow the last selected
known call. Unknown explicit IDs do not corrupt an unrelated existing call.

## Alternatives considered

Always append arguments: works for incremental chunks but corrupts snapshots.
Always replace arguments: loses incremental chunks and cannot retract Chat SSE
already delivered. Deduplicate only in the collector: streaming clients would
still receive duplicate calls and invalid argument deltas.

## Consequences

Normalization precedes both SSE and its structured collector twin, preserving
the same calls, IDs, names and argument JSON in both response modes. Tracking
arguments retains one accumulated string per call during streaming. Prefix
detection follows the observed mixed snapshot/incremental convention; it does
not repair arbitrary upstream rewrites of an already-emitted argument prefix.
This offline fixture does not establish the cause of a production missing-query
incident, and changes no request construction, model defaults or deadlines.

## Verification

- `tests/windsurf-collect-parity.test.ts::actual adapter normalizes interleaved tool snapshots and incremental args`
  feeds protobuf/Connect frames through the actual adapter in both modes. It
  checks repeated headers, growing and equal snapshots, ID-only continuations,
  ID-less incremental chunks, interleaving, unchanged empty-object arguments,
  exact SSE indices/suffixes and collected JSON.

Proved: Before the normalization change, the focused adapter test failed in
both modes: non-streaming returned six tools instead of three with corrupted
arguments, and streaming emitted repeated IDs with new indices. Output from
`bun test tests/windsurf-collect-parity.test.ts -t 'actual adapter'` is retained
in `.agents/notes-evidence/windsurf-tool-delta-red.log` (workspace path removed).
After the fix the same test passes in both modes; the focused five-file Windsurf
run passes 62 tests.
