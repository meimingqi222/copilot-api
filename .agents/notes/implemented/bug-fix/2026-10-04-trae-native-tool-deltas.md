# Agent Note: Assemble Trae CN native tool deltas before emitting calls

Status: implemented

## Problem

Doubao emits a native tool name and id with empty arguments, followed by an unnamed event at the same index carrying the arguments. Processing each event independently emitted an empty object and discarded the unnamed continuation. The live server had five empty calls missing required fields; a fixed diagnostic request reproduced this two-event format. Direct Trae client and OAuth imports also encountered a callback constant initialization cycle.

## Decision

Collect native tool events by upstream id and index until the stream finishes, then normalize and emit each named call once. Append argument deltas and accept cumulative snapshots or repeated complete snapshots. Both streaming and non-streaming consumers use the same assembled parts. Put callback constants in a dependency-free module, retaining the OAuth re-exports.

## Alternatives considered

**Normalize each event to an object.** Partial or empty arguments cannot be parsed yet, and converting them to an empty object loses required inputs.

**Require names on every event.** Native streaming continuations omit names and ids; the index identifies their pending call.

## Consequences

Native calls are emitted after upstream completion rather than exposing partial arguments. Text tool blocks retain their existing handling. The host's IR and credential persistence contracts remain unchanged. Malformed complete arguments still follow the existing normalization fallback; this fix does not invent missing parameters.

## Verification

- `tests/trae-cn-tool-stream.test.ts`
- `tests/provider-modules.test.ts`

- `tests/trae-cn-tool-stream.test.ts::Doubao sends the tool name before its arguments in an unnamed continuation`
- `tests/trae-cn-tool-stream.test.ts::Trae native argument fragments become one complete call in both client modes`
- `tests/trae-cn-tool-stream.test.ts::parallel tool fragments retain identity and cumulative snapshots replace partial arguments`
- `tests/provider-modules.test.ts::refresh-only, OAuth-only and protocol-only entry points work in a fresh process`

Proved: before the accumulator fix, the fragment and parallel-call regressions failed (0 pass, 2 fail, temp/trae-tool-red.log); after restoring the fix they pass. A direct client import also failed with Cannot access TRAE_CN_CALLBACK_PORT before initialization before splitting the constants; fresh-process imports now pass. Live Doubao diagnostics independently confirmed an empty named event followed by an unnamed event containing an object with the required field.
