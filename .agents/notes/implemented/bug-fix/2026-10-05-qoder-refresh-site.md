# Agent Note: Qoder refresh follows the connection site

Status: implemented

## Problem

Qoder and Qoder CN share qoder-native, but their token domains are separate. Refresh selected the module's fixed site using provider metadata, while inference and quota already selected the site using the connection baseUrl. A connection with international baseUrl and stale qoder-cn metadata therefore sent its international job refresh token to the CN server and was permanently marked auth_error on 401. Read-only inspection of qoder-15 found this mismatch; international device userinfo still returned 200. No production refresh token was consumed during diagnosis.

## Decision

Resolve the site inside the Qoder refresh operation with qoderSiteForConnection, matching inference and quota. Apply this to both job-token and device-chat refresh. Preserve host-owned auth update merging and persistence, and retain genuine upstream rejection as terminal. Login continues to use the user's selected site.

The same site resolution now owns Qoder attribution in `src/lib/provider-connections/connection-metadata.ts` and the account view through `src/lib/provider-connections/protocol-provider.ts`. In `src/lib/provider-connections/boot.ts`, repair both absent and conflicting provider metadata, not just absent values. Otherwise an international connection can still appear in the Qoder CN group while inference correctly uses the international host. The site helper reads raw metadata and the pure protocol catalog for its fallback; it must not call the provider reader back recursively.

## Alternatives considered

- Change request headers: the existing refresh contract matches the reference implementation; the concrete defect is the token domain.
- Recover every job 401 by minting another job token: unnecessary for this failure and could hide true credential rejection or introduce device refresh rotation races.
- Correct only the production metadata: would leave missing or inconsistent historical metadata susceptible to the same bug.
- Rename or merge the UI groups: would hide incorrect provider attribution rather than align the account API with its actual request site.

## Consequences

Recognized connection baseUrl determines the refresh domain, even when dispatch selected the other Qoder module. Unknown baseUrl retains the helper's provider fallback. This patch does not modify production credentials or deploy code. Existing terminal auth_error accounts require an explicit refresh after updating; device token validity alone does not prove the job refresh token remains valid.

Account display and provider readers also follow that recognized baseUrl even before boot repair. Boot persists the corrected provider without changing the upstream address or credentials. Unknown/custom hosts keep the existing metadata/protocol fallback; they are not guessed from account names or tokens.

## Verification

- `tests/oauth-qoder.test.ts::connection host despite conflicting provider metadata` covers both sites and both token kinds, with wrong-host requests rejected as 401.
- `tests/oauth-qoder.test.ts::international connection without provider metadata refreshes on the international host` covers missing metadata and the shared protocol fallback.
- `tests/oauth-qoder.test.ts::account view follows` covers both sites with correct, conflicting and absent metadata through the public account view and the provider reader.
- `tests/provider-connections-store.test.ts::boot persists Qoder providers matching the connection hosts` covers correction of conflicting and absent metadata on disk for both sites.

Proved: pre-fix focused run failed all five regressions (four wrong-domain 401 errors and one host assertion); captured output excerpt is saved in `.agents/notes-evidence/qoder-refresh-site-red.log`. After the fix, bun run test:affected passed all 65 tests across seven files, including these five regressions.

Proved: before the attribution fix, the focused account-view and boot run failed three account provider assertions and the persisted provider assertion (3 pass, 4 fail); output is saved in `.agents/notes-evidence/qoder-provider-attribution-red.log`. The same focused run passed all seven cases after the fix.
