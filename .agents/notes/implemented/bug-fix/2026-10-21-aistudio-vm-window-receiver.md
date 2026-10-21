# Agent Note: Bun VM context Window receiver alias

Status: implemented

## Problem

On Linux Bun 1.4, unqualified global getters such as document use the vm context object as their receiver. The DOM shape in `src/services/aistudio/waa/index.ts` registered globalThis as Window, but that wrapper differs from the context object. The real WAA interpreter therefore failed its Window brand check before producing a proof. Windows Bun 1.3 did not reproduce the mismatch.

## Decision

Register the context object with the same Window brand as its own realm global after DOM installation, for top and iframe realms. Do not relax checks for unrelated objects or replace the browser getter implementations.

## Alternatives considered

- Accepting all objects as Window would break WebIDL receiver checks.
- Catching the WAA error would hide a failed proof and could not restore generation.
- Changing account credentials cannot fix a local vm receiver mismatch.

## Consequences

The context and global wrapper represent the same Window. Ordinary objects still fail the document getter brand check. Each runtime retains isolated brand maps and cleanup behavior.

## Verification

- `tests/aistudio-waa.test.ts` checks unqualified document reads, globalThis equality and rejection of a forged receiver.

Proved: the synthetic regression was run on the production Linux Bun 1.4 runtime via stdin: before the alias fix it failed with WAA execution failed; after the fix it passed. Both baseline and constrained synthetic tool generation then returned HTTP 200 with STOP on the affected account. The three AI Studio test files passed 29 tests locally; lint and typecheck passed.
