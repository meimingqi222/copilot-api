# Agent Note: Keep exposed routing groups in Codex model discovery

Status: implemented

## Problem

src/lib/routing-groups/catalog.ts advertised exposed groups without
supported_endpoints. The Codex text-model filter excluded those entries from
both client discovery and the system settings model choices. Saving a group ID
manually did not help because selection runs after text-model filtering.

## Decision

Declare the text client endpoints accepted by group routing in the shared
public group catalog. These describe proxy entry points, not a member's native
wire or guaranteed model capabilities. Keep the Codex filter unchanged so
image and embedding models remain excluded. Context and vision limits remain
unspecified for mixed groups.

## Alternatives considered

- Special-case group IDs in the Codex filter: leaves shared catalog metadata
  incomplete and couples one client's discovery to group naming conventions.
- Copy one member's native endpoints and capabilities: groups can contain
  different models and dispatch through protocol translation.

## Consequences

Exposed groups appear in the administrator choices and Codex catalogs, including
custom selection. Unexposed groups remain hidden and caller model permissions
still apply. Request routing and the stored system configuration do not change.

## Verification

- `tests/codex-client-models.test.ts` covers exposed routing groups through
  discovery, custom selection and permission filtering.

Proved: Before the fix, the regression failed because administrator choices did
not contain group/codex-pool (0 passed, 1 failed). The red output is retained in
ignored temp/codex-group-red.log. After the fix the same test passes, covering
administrator discovery, default and selected Codex catalogs, permitted and
denied callers, unexposed groups and ordinary model catalogs.
