# Agent Note: Preserve callback owner enumeration during provider modularization

Status: implemented

## Problem

The module-backed callback compatibility table exposed every provider as an own key, including providers without a callback configuration. Consumers enumerating the table could mistake these undefined entries for supported callback providers.

## Decision

Keep the compatibility view lazy to avoid module initialization cycles, and derive its own keys, membership and property descriptors only from modules that contribute callback configuration. Direct reads still resolve the module contribution.

## Alternatives considered

A static callback owner list would duplicate provider registration. Eagerly materializing the table would introduce module initialization dependencies. Keeping all provider keys would change the former table's enumeration contract.

## Consequences

New callback providers contribute configuration through their module without editing a separate callback list. Enumeration and membership agree with the available configurations, while existing provider-specific callback options remain unchanged.

## Verification

- `tests/provider-contributions.test.ts`

Proved: Restored the HEAD version of flows.ts temporarily and ran the bound test; it failed because ten non-callback providers appeared as extra keys. Restored the fixed file byte-for-byte and reran the same test; it passed with eight assertions. The full fixed suite also passed with 2401 tests and zero failures.
