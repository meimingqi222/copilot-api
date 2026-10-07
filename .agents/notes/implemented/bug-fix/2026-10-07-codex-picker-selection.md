# Agent Note: Curate the Codex client model picker

Status: implemented

## Problem

Codex Desktop requests model/list with limit 100 and does not fetch the next
cursor. A complete proxy catalog can therefore put wanted public model IDs
outside the visible page. Hidden models count towards that page as well.

## Decision

Persist one nullable ordered codexModelIds list in src/lib/system-config.ts.
Null preserves the full catalog; an empty list selects no visible models.
Validate a maximum of 100 unique nonempty public IDs. Omitted updates preserve
the stored list and diagnostic expiry does not reset it.

src/services/codex/client-models.ts applies selection only to Codex catalogs,
after caller permissions. Give selected visible entries priorities 0 through
99 and retain hidden entries with priorities starting at 100. Ordinary model
catalogs, native review overrides, access controls and request routing stay
unchanged. Missing IDs are skipped without deleting the saved selection.

src/routes/admin/api/system-config.ts exposes all eligible picker choices to
admins regardless of the saved filter, including public routing group IDs.
pages/js/views/system-config.js and pages/partials/system-config.html provide
search, selection and ordering. Recommended diagnostic settings retain the list.

## Alternatives considered

**Patch the third-party Desktop application.** Creates maintenance work after
application upgrades. Curating the server catalog uses the supported protocol.

**Truncate all model catalogs to 100.** Changes ordinary API discovery and
still gives users no control over which models occupy the first page.

**Filter out all unselected entries including hidden models.** Removes native
review metadata and can break automatic review. Hidden entries are preserved.

## Consequences

Customization is opt-in and global. Different public IDs remain independent;
this does not merge routing aliases or broaden caller permissions. Client
catalog caching still governs when updated choices appear. The admin choices
endpoint returns IDs and names, never connection credentials or native prompts.

## Verification

- `tests/codex-client-models.test.ts` covers selected order, empty and null modes,
  native reviewer retention, ordinary catalog compatibility, caller permissions,
  all eligible admin choices and all 100 visible models fitting the first page.
- `tests/system-config.test.ts` covers persistence, expiry, omitted updates,
  invalid lists, the 100-item boundary and admin authentication.
- `tests/system-config-view.test.ts` covers search, ordering, selection limits,
  recommended settings and saving enabled or disabled custom lists.

Proved: Before implementation, both custom picker tests failed with an
unrecognized codexModelIds setting while the existing nine catalog tests passed.
After implementation the same tests pass, including the 100-entry page case.
