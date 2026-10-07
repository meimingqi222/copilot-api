# Agent Note: Isolate optional model discovery from system configuration

Status: implemented

## Problem

`pages/js/views/system-config.js` loaded configuration and optional Codex model
discovery through one Promise.all. Discovery failure or delay prevented the
configuration form from loading. Enabling custom model selection initialized
an empty list that could silently clear the client's model picker on save.

## Decision

Load the optional model catalog independently and display its failure locally
in `pages/partials/system-config.html`. The configuration form can load and save
while discovery is failing or pending. Confirm empty custom model selection
before saving, with translations in `pages/js/i18n.js`. Keep intentionally empty
lists supported by the API and preserve the existing usage_missing policy.

## Alternatives considered

- Catch discovery failure inside Promise.all: still blocks configuration when
  discovery is pending.
- Reject empty lists in the API: removes an intentional configuration option.
- Silently restore default models: discards the administrator's configuration.

## Consequences

Model discovery errors do not prevent editing unrelated settings. Declining
empty selection confirmation sends no update; accepting it preserves the empty
list behavior. Normal default and nonempty selections save without confirmation.

## Verification

- `tests/system-config-models-resilience.test.ts`
- `tests/system-config-models-resilience.test.ts::catalog failure leaves system configuration editable and saveable`
- `tests/system-config-models-resilience.test.ts::a pending catalog does not block loading or saving configuration`
- `tests/system-config-models-resilience.test.ts::empty custom model selection requires confirmation before saving`

Proved: Restoring the previous view implementation failed all three assertions:
settings remained null after catalog failure, a pending catalog blocked loading,
and an empty list saved without confirmation. Restoring the fix passed all three
tests. The red output is retained in ignored temp/system-config-resilience-red.log.
