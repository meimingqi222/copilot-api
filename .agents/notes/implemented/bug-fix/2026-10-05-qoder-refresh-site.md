# Agent Note: Qoder refresh follows the connection site

Status: implemented

## Problem

Qoder and Qoder CN share qoder-native, but their token domains are separate. Refresh selected the module's fixed site using provider metadata, while inference and quota already selected the site using the connection baseUrl. A connection with international baseUrl and stale qoder-cn metadata therefore sent its international job refresh token to the CN server and was permanently marked auth_error on 401. Read-only inspection of qoder-15 found this mismatch; international device userinfo still returned 200. No production refresh token was consumed during diagnosis.

## Decision

Resolve the site inside the Qoder refresh operation with qoderSiteForConnection, matching inference and quota. Apply this to both job-token and device-chat refresh. Preserve host-owned auth update merging and persistence, and retain genuine upstream rejection as terminal. Login continues to use the user's selected site.

## Alternatives considered

- Change request headers: the existing refresh contract matches the reference implementation; the concrete defect is the token domain.
- Recover every job 401 by minting another job token: unnecessary for this failure and could hide true credential rejection or introduce device refresh rotation races.
- Correct only the production metadata: would leave missing or inconsistent historical metadata susceptible to the same bug.

## Consequences

Recognized connection baseUrl determines the refresh domain, even when dispatch selected the other Qoder module. Unknown baseUrl retains the helper's provider fallback. This patch does not modify production credentials or deploy code. Existing terminal auth_error accounts require an explicit refresh after updating; device token validity alone does not prove the job refresh token remains valid.

## Verification

- `tests/oauth-qoder.test.ts::connection host despite conflicting provider metadata` covers both sites and both token kinds, with wrong-host requests rejected as 401.
- `tests/oauth-qoder.test.ts::international connection without provider metadata refreshes on the international host` covers missing metadata and the shared protocol fallback.

Proved: pre-fix focused run failed all five regressions (four wrong-domain 401 errors and one host assertion); captured output excerpt is saved in `.agents/notes-evidence/qoder-refresh-site-red.log`. After the fix, bun run test:affected passed all 65 tests across seven files, including these five regressions.
