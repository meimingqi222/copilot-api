# Agent Note: Pause the Doubao Work desktop integration

Status: implemented

## Problem

Doubao Work's desktop bridge is not a suitable default upstream for a server. The CLI has not been validated as a substitute for a model API with caller-owned tools.

## Decision

Keep the provider and protocol registered for saved accounts, but register an inert runtime in `src/services/providers/builtins.ts`. Exclude the protocol from both route construction and model exposure, and hide it from new-account selection. Do not remove the implementation or mutate saved account and model settings.

## Alternatives considered

Hiding only the picker would leave explicitly addressed models and stored group members callable. Removing the protocol from metadata would invalidate saved connections.

## Consequences

Existing Doubao Work records remain readable but cannot serve requests or launch the desktop bridge. Volcengine Ark and other providers are unaffected.

## Verification

- `tests/doubao-work.test.ts::the paused Doubao Work module preserves saved models but cannot sign in or route`
- `tests/provider-presentation.test.ts::the paused Doubao Work provider stays out of the Add Account picker`
