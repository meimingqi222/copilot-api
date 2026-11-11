# Agent Note: Account-scoped Claude Code print and interactive modes

Status: implemented

## Problem

The existing CLI transport always used `-p`. An interactive entrypoint needs a
real terminal while preserving the server's stream-json, tool callback and
session ownership contracts. Merely removing `-p` leaves terminal output in
the JSON pipe; reusing a live run after a card change ignores the saved mode.

## Decision

`src/services/claude/cli/mode.ts` selects `print` by default and permits
`interactive` through `connection.metadata.claudeCliMode`. The account card,
`src/routes/admin/api/account-update.ts` and
`src/routes/admin/api/account-views.ts` round-trip that setting without a model
refresh. HTTP selection and the global HTTP override retain precedence.

`src/services/claude/cli/bridge.ts` includes the configured and effective mode
in run ownership. The interactive helper in
`src/services/claude/cli/tui-helper.ts` uses Bun's native PTY on supported POSIX
runtimes, with node-pty reserved for Windows and older Bun runtimes, and an actual
headless terminal screen: native Claude redraws the trust selection by moving the
cursor, so stripping ANSI from accumulated text cannot identify the choice.
Only the service-owned empty working directory is trusted. Built-in tools
remain disabled and only this run's MCP server is allowed.

Requirement revised on 2026-11-01 after reviewing magpie's follow-up changes:
an interactive account never falls back to print, including before user input.
Native search, JSON Schema and text exceeding 400 KB are rejected before run
checkout or startup. Search retains its existing Print permission protocol so
domain and max-use constraints cannot disappear. Missing PTY support or failed
interactive startup is a local unavailable error, without credential cooldown.
Print remains an explicit account choice and is still the default.
Claude-native safeguards are passed through the isolated `CLAUDE_CODE_EXTRA_BODY`;
the complete payload session key forces a fresh run when that context changes.

`src/services/claude/cli/tui-images.ts` accepts inline and public URL images,
validates actual image bytes, pins checked DNS addresses at the socket and
rechecks redirects. It deliberately loads `undici/index.js`: Bun's built-in
undici Agent is a stub that ignores the required connector. Fetches are direct
and carry no account credentials. Each image is at most 5 MB; message files and
the per-run URL cache are capped at 20 MB, with 20 files per message and 32 cached
URLs. Files are pasted in order, waiting for Claude Code's image acknowledgment,
then deleted after the user row is persisted. Acknowledgments use only output
since the current paste; retained markers from previous turns must not release
the wait before Claude finishes loading the new image. Downloads stop on cancellation.

`src/services/claude/cli/tui-events.ts` joins main tapped SSE with the session
transcript by message ID. Streamed replies suppress their persisted twin;
transcript fallback keeps every content block, including identical signed
thinking rows, and retains blocks appended after an earlier quiet interval.
An unidentifiable main stream uses transcript output instead of exposing a
background request. The helper removes its transcript after the PTY exits;
forced termination retains the existing transcript TTL cleanup as a backstop.
Synthetic refusal rows are held until Claude Code finishes retrying. A final
refusal retains its stop reason; a subsequent HTTP error remains an error.

Completed message IDs remain in a bounded 1024-entry recent history after a
turn settles. The tap and transcript are read independently, so a transcript
can finish a turn before the next tap read observes that reply. Clearing every
ID at result delivery lets that late copy contaminate the next response.
Both late tapped messages and late transcript copies are suppressed; per-turn
stream state is still cleared and the recent history is bounded for long runs.

## Alternatives considered

Changing `CLAUDE_CODE_ENTRYPOINT` would only label a print run. Scraping rendered
answer text would lose tool arguments, signatures and token usage. Routing
native search through unrestricted interactive permissions would bypass caller
constraints. Installing node-pty as mandatory would break print-only Linux
installations without native build tools, so it is optional and loaded only by
the interactive helper's compatibility branch. It cannot be the default on
POSIX: its native addon failed the CI PTY scenarios and hung under Bun locally,
while the same addon worked under Node. Bun's built-in terminal avoids that
addon and its Linux build requirement; child exit closes the terminal handle.
Retrying as print was deliberately removed because it
changes the selected mode and prompt cache; startup failure cannot authorize it.

## Consequences

Existing accounts keep print mode. Interactive mode needs persistence while a
run lives and cannot use `--no-session-persistence`. Its main-stream tap is
version-dependent, with complete-block transcript output as the fallback.
The MIT-licensed magpie tap attribution is shipped with the build.

`tsdown.config.ts` must keep node-pty external: bundling its JavaScript moves
native-module and ConPTY-worker resolution into dist and breaks every built
interactive run. It also copies the tap and MIT notice to dist.
Run the same PTY regressions against a build with
`COPILOT_API_TEST_CLAUDE_ENTRY=dist/main.js bun test tests/claude-cli-tui.test.ts`.

Regression coverage is in `tests/claude-cli-tui.test.ts` (real PTY input/output,
partial trust redraw, signed thinking, tool callbacks, mode isolation, startup
refusal retries, images, strict startup failure and cancellation),
`tests/claude-cli-images.test.ts`, `tests/account-update.test.ts`,
`tests/accounts-claude-cli-status.test.ts` and `tests/claude-cli-env.test.ts`.
The image PTY fixture accepts the protective whitespace before slash-leading
file paths; image ordering, bytes and post-acceptance cleanup stay asserted.
`tests/admin-account-view-parity.test.ts` verifies the account API response,
subsequent listing and the persisted connection record agree on the mode.
That suite explicitly enables persistence through
`src/lib/provider-connections/state.ts`'s `__resetProviderConnectionsForTest`
in a fresh temporary data directory, then resets persistence and restores the
data path during cleanup. The reset hook otherwise defaults to disabling disk
writes; without the explicit opt-in, earlier reset-calling suites leave PUT and
GET correct but prevent the disk assertion from exercising persistence.

Verification:

- `tests/claude-cli-tui.test.ts::transcript fallback preserves separate signed thinking rows and suppresses late tapped duplicates`
  also delivers an old tap after the first result has settled, then completes a
  second turn through the production stream translator and collector. Only the
  second answer may appear in that result.

Proved: Before retaining completed IDs, the deterministic late-tap extension
received `{"turn":1}{"turn":2}` instead of `{"turn":2}`, reproducing invalid JSON
without PTY timing or sleeps. Natural-red output is retained in
`.agents/notes-evidence/claude-late-tap-red.log`. The CI image test did not retain
its malformed response, so this proves the implementation defect and matching
failure mechanism, not that this was the only possible cause of that CI run.
