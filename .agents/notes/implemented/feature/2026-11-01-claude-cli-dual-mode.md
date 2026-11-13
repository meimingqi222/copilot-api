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
then deleted after the user row is persisted. The complete terminal grid is
retained across pastes: Claude Code can repaint only the digit of an image
marker and reuse its other cells. A second grid contains only cells painted
since this paste. Acknowledgments use that fresh output, or a changed prompt
ending in the expected marker; an unchanged old prompt must not acknowledge a
new image. Downloads stop on cancellation.

Before the first paste, the prompt and a completed MCP `tools/list` are both
required. `src/services/claude/cli/mcp-helper.ts` writes the per-run listed file
after sending its tools. A drawn prompt alone is not proof that tools loaded.

Interactive effort changes use the existing acknowledged control channel.
`src/services/claude/cli/tui-tap.js` reads an atomically replaced per-run effort
file and changes only `output_config.effort` on main Messages requests. Other
body fields, background requests and the caller's Request/init remain intact.
The helper accepts updates only after the tap has processed a main request.
Without that handshake, or when restoring an implicit default in a run started
with explicit `--effort`, the bridge restarts in interactive mode. It never
types `/effort` (which can change saved account defaults) or falls back to `-p`.

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

The 2026-11-13 follow-up was checked against Magpie main
`363adb352806f4b2a52673672a83b62f89313daa` (latest release `v0.1.3961`):
`b7631300ec6a` supplies successful replies' allowance from the main response
headers; `9e6687e3a5d1` and `325dc3ab3233` cover startup dialogs and undrawn
process diagnostics; `fe6533ad8bf7` drains terminal output before recording exit.
The tap copies only `anthropic-ratelimit-unified-*` headers. The event merger
tells their finite window readings before `message_start`, or after a complete
transcript message at turn settlement, never merely when the headers arrive.
Stream sequence numbers prevent an older reading overwriting a newer one;
synthetic errors' readings supersede all already-read tap headers.
After a transcript turn-end row the helper rereads the tap before settlement:
its first read can have hit EOF just before the reply wrote its headers.
A late duplicate of an already-completed message may still report its latest
allowance at its stream end while idle, without replaying the answer or waiting
for another turn. The completed-message regression covers both contracts.

Startup retains the terminal grid while retrying ignored onboarding keys.
Chrome is declined with Esc; Bypass Permissions consent is never given, even
in our config directory, because our allowed-tools contract does not need it.
An undrawn run reports byte count and, on POSIX, descendant program names and
memory. A detected macOS `security find-generic-password` descendant is reported
as a pending Keychain read, not proof of a locked keychain. Process arguments
are never included in these diagnostics. Terminal exit waits briefly for final
PTY bytes and queued screen parsing. None of these failures retries as Print.
Magpie's Go-specific PTY changes and terminal `/usage` fixes are not ported:
this bridge uses Bun's PTY and fetches quota directly through the OAuth API.

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

- `tests/claude-cli-tui.test.ts::interactive %s are pasted as files in order and removed after acceptance`
  covers partial-number redraws, 19 interleaved images over two turns, exact
  byte/order delivery, file cleanup and same-process reuse.
- `tests/claude-cli-tui.test.ts::the first interactive prompt waits for the MCP tool list`
  runs the production MCP helper with a delayed list request.
- `tests/claude-cli-tui.test.ts::interactive effort changes with %s from %s keep the selected mode`
  covers same-process updates, restoring the default and no-tap restarts.
- `tests/claude-cli-tui.test.ts::tap tees only main SSE and leaves the actual request and response bytes intact`
  checks actual outgoing effort for JSON-string and Request bodies, preserves
  safeguards/format, and controls background requests and removed overrides.
- `tests/claude-cli-tui.test.ts::a silent interactive turn fails with 502`
  checks both streaming and non-streaming admission and run cleanup.

Proved: Before the fixes, the real PTY fixture's partial image-number redraw
timed out with HTTP 502; the slow MCP fixture answered with `toolsListed:false`;
effort updates restarted the run, and the tap sent medium instead of xhigh.
Sanitized failing output is retained in
`.agents/notes-evidence/claude-cli-parity-red.log`. The image red used two
images; the green regression was then extended to 19 per turn. These tests use
real PTYs and the production bridge with a fake Claude executable, not paid
Claude inference; they reproduce the terminal mechanism, not a live account's
version-specific rendering.

- `tests/claude-cli-tui.test.ts::interactive reply limits keep the newest observation when old streams end %s`
  checks both stream completion orders and newer synthetic errors.
- `tests/claude-cli-tui.test.ts::transcript replies defer tapped limits until the complete message ends`
  protects transcript fallback from mid-message allowance delivery.
- `tests/claude-cli-tui.test.ts::a successful interactive response updates the credential allowance (stream=%s)`
  exercises the PTY, event translation and typed credential quota together.
- `tests/claude-cli-tui.test.ts::interactive startup diagnostics explain %s without exposing process arguments`
  checks refusal of unsafe consent, final output and a simulated waiting
  Keychain subprocess. It never invokes the real Keychain or reads credentials.
  macOS must identify the Keychain read; Linux must report waiting program names
  and resident memory, not the script filename (`ps` can name its interpreter).

Proved: Before this follow-up, allowance events were absent (five assertions
failed), the Chrome offer was misread as the prompt and the turn failed with
502, and an early exit lost Claude Code's startup explanation. Sanitized natural
red output is in `.agents/notes-evidence/claude-magpie-followup-red.log`.
These regressions and their green reruns use fake Claude processes with real
PTYs, not paid inference or a live locked Keychain.
