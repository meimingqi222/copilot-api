# Agent Note: Built-in scan sign-in for web-session providers

Status: implemented

## Problem

The providers added in `7c2a155a` (Astron Studio, Baidu DuMate, InkStone, WPS
Lingxi) only accepted a manually pasted cookie/token, while the same vendors in
the sibling auto-checkin project sign in by scanning a vendor QR code. A server
operator had to copy a cookie out of DevTools on another machine.

## Decision

Add a separate **web sign-in** capability instead of folding these providers into
the OAuth registry. `src/services/web-login/` starts one temporary headless
Chromium on the proxy host, opens the vendor login page, screenshots the QR
element for the dashboard, polls the browser's cookies, and hands the captured
session to that provider's existing `accountCreation.prepare` — so a scanned
sign-in and a pasted one share exactly one validation and token-minting path.
The dashboard calls `/admin/api/web-login/:provider/{start,poll,cancel}` and the
descriptor's `presentation.webLogin` decides which providers show the button.

Chromium reuse rather than a second browser stack: `src/services/web-login/browser.ts`
drives `src/services/zcode/cdp.ts` (launch + `Runtime.evaluate`) and
`ensureZcodeBrowser()`, which already solves "no Chrome on this server" (env var →
recorded install → system path → download Chrome for Testing).

QR readiness is judged in the page, not by a fixed sleep, and every clause comes
from a real page (2026-11-21, read-only):

- the candidate image list includes the matched element itself, because the
  selector often points straight at the QR `<img>` (`.sso-qrcode img`,
  `img.tang-pass-qrcode-img`, `.qrcode_img img`);
- the image URL must contain the hint (default `qrcode`): Baidu's passport page
  renders a loading placeholder with the same box size as the QR, and Astron
  Studio renders an empty container first — both would otherwise be screenshotted;
- a container that only wraps an iframe (InkStone's WeChat QR on
  `open.weixin.qq.com`) is ready when the iframe itself shows a large loaded
  image. Cross-origin DOM is unreadable, so the iframe is attached over CDP
  (`Target.setDiscoverTargets` + `Target.attachToTarget`);
- the screenshot clip adds `window.scrollX/Y`, because `scrollIntoView` moves the
  element and CDP clip coordinates are page-relative, not viewport-relative.

Exchange runs **once** per flow. InkStone's `createApiKey` creates a real vendor
key and its own account creation states that a failed or ambiguous POST must
never be retried or deleted, so a rejected session settles the flow as an error
instead of polling the vendor again. Terminal flows stay in the map for five
minutes (no immediate delete) so a second poll or a second tab reads the same
conclusion, and a terminal flow never occupies the per-provider mutex.

The captured session goes into `prepare`'s `credentials`; the per-connection proxy
and provider-specific switches go into `prepare`'s `settings`. InkStone reads
`settings.createApiKey` and DuMate reads `settings.proxyUrl`, so putting either
one in credentials would be silently ignored — the account would be created
without a key or without its proxy.

## Alternatives considered

**Mark these providers `oauth: true` and reuse the OAuth flow registry.**
`validateProviderModules` then requires `oauth` + `refreshAuth`, the flow would be
persisted to disk across restarts (a browser handle cannot be), and the badge,
account-creation tabs and refresh scheduling would all change for providers that
have no OAuth at all.

**Read the desktop client's local credential files on the proxy host.** That is
what Astron Studio's `importDesktop` does as an opt-in, but as a default it is a
per-machine trick: the proxy host is not the machine where the user signed in.

**Retry the exchange while the session looks incomplete.** Duplicate vendor-side
writes (InkStone keys) and duplicate accounts; the manual paste path has the same
one-shot semantics.

## Consequences

Scan sign-in is available for four providers; Raccoon, CodeArts and Meoo keep
their OAuth flows, and Doubao Work stays paused. The proxy host must be able to
run Chromium (the same requirement ZCode's captcha solver already had); when it
cannot, start fails with the installer's readable reason instead of a blank QR.
Each scan login creates a new account, exactly like a pasted cookie — repeated
logins do not merge into an existing connection, so an operator should reuse the
existing account when re-authorizing.

## Follow-up (2026-11-22): InkStone exchanges the redirect login code itself

The sibling auto-checkin project hit this live on 2026-11-22: the InkStone scan
*looked* successful (the console loaded and routed to `/chat`) yet no credential
was captured, because the console is an SPA — it consumes `?code=uaa::code::…`
from the landing URL and routes away, and the code exchange is one-shot. Waiting
for the `uaa-token` cookie therefore depends on the SPA finishing its own
exchange, and polling the page URL misses the code entirely once it routes.

The desktop client (inkstone 0.2.13 `ExternalAuthOverlay`) answers this with
`preventDefault()` on the code-carrying navigation. CDP has no such hook, so
`browser.ts` now arms `Fetch.enable` (Document requests only) right after
`Page.navigate` and fails the request whose URL matches the provider's new
`captureCode` predicate; everything else is continued. The captured code goes
through the provider's new `exchangeCode` hook (`POST /api/user-center/v1/users/auth`
`{code}` → `{code:0, data:{token}}`, invalid/used → `-40132`), and the JWT lands
in `prepare`'s credentials as `uaaToken` — the same value the console stores as
its `uaa-token` cookie.

Clauses worth keeping:

- **The code criterion checks origin + `uaa::code::` prefix, not the path.**
  The SPA routes the landing document to `/chat`; a pathname check (what the
  desktop client uses, because it sees the URL mid-navigation) drops the code.
  The SSO midpage `/wechat?code=` carries the *WeChat-side* code and is
  rejected by the origin check — exchanging it only yields `-40132`.
- **Cookie capture stays as the fallback**, not the primary path: if
  interception fails to arm, or the redirect opens a popup the page-level
  handler never sees, the SPA loads and the cookie still arrives.
- **A captured code is exchanged exactly once.** `-40132` means the code was
  already consumed (interception missed, the SPA loaded once); retrying only
  repeats the rejection, so the flow settles as an error telling the user to
  scan again — same one-shot semantics `prepare` already had for key minting.
- **`Fetch.enable` is armed right after navigate, before the QR renders.**
  The SSO redirect chain is paused-then-continued (no code in those URLs);
  verified live, QR rendering is unaffected.
- `CdpConnection` now dispatches events (`onEvent`). It previously dropped every
  message without an `id`, so `Fetch.requestPaused` was unreachable. One broken
  handler cannot affect other subscribers or command responses.

## Verification

- `tests/web-login.test.ts` — provider registry and per-provider session
  extraction, cookie-domain suffix matching, one active flow per provider,
  pending→complete transition, single-exchange-on-failure, QR failure ending the
  flow, cancel closing the browser, route wiring and unknown-flow handling.
- `tests/web-login.test.ts::the scanned session reaches prepare with the proxy
  and provider settings` pins the credentials/settings split above.
- `tests/web-login.test.ts::the QR readiness expression embeds the selector, hint
  and self-check` pins the three page-behaviour clauses above; dropping any of
  them silently screenshots a loading placeholder again.
- `tests/web-login.test.ts::the inkstone login-code criterion accepts the console
  and rejects the SSO midpage` pins origin-vs-path and the midpage rejection.
- `tests/web-login.test.ts::a captured login code drives the exchange and reaches
  prepare as uaaToken` / `a rejected login code settles as an error and never
  retries the vendor` pin the one-shot exchange and the credentials/settings
  split for the code path.
- Real-page probe (`temp/qr-probe.ts`, not committed) opened all four vendor
  login pages headlessly and produced a scannable QR for each: Astron Studio
  190×190, DuMate 150×150, InkStone 179×179 (cross-origin WeChat iframe), WPS
  Lingxi 180×180.
- Follow-up probe (`temp/inkstone-intercept-probe.ts`, not committed) armed the
  same interception against the real SSO page: the code-carrying document was
  failed, the page stayed on `sso.openxlab.org.cn/wechat`, a normal document
  navigation was continued, and the fake code hit the live exchange endpoint
  (`-40132`).
- `bun run lint`, `bun run typecheck`, `bun run format:check` and `bun run knip`
  are clean.
