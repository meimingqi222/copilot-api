# Agent Note: Trace animation DOM compiler and packet positioning

Status: implemented

## Problem

The supplied Chrome trace shows the Tailwind CDN attribute observer consuming
4606 ms across 133 calls, while packet RAF callbacks consume about 80 ms.
Changing SVG coordinates repeatedly triggers browser-side CSS compilation.
New circles are also inserted without coordinates, so a delayed RAF exposes
SVG's default origin. Candidate DOM order can briefly differ from model order.

## Decision

Generate Tailwind 3 utilities from dashboard HTML and JavaScript at build time,
serve the committed static stylesheet, and regenerate it on build/dev startup.
Create packets hidden and position them synchronously before the first RAF.
Hide packets when their path is missing and reposition on geometry redraw.
Cache path lengths for each flight and only change classes on phase changes.
Pair candidate elements with paths by stable route keys instead of array index.

## Alternatives considered

**Only optimize RAF callbacks.** This leaves the dominant DOM observer cost.

**Remove Tailwind without a replacement.** This breaks existing utility styling.

**Delay packet insertion by one RAF.** A busy main thread can still expose
unpositioned packets; synchronous positioning and initial hiding are reliable.

## Consequences

Dashboard animation no longer needs the CDN CSS compiler. New utility classes
must be complete literals in scanned HTML/JS; run `bun run build:css` after
editing them during development. The generated stylesheet is tracked so source
checkouts can serve it without a build. Existing protocol behavior is unchanged.

## Verification

- `tests/traces-view.test.ts`

Proved: before implementation, `bun test tests/traces-view.test.ts` failed the
new first-frame test (cx undefined), geometry-cache test (two measurements
instead of one), and dashboard compiler test (CDN still present). All three
passed after applying the fix. A separate candidate-reordering test verifies
route identity rather than positional pairing.
