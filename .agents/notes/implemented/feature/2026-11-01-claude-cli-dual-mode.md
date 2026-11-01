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
`src/services/claude/cli/tui-helper.ts` uses node-pty and an actual headless
terminal screen: native Claude redraws the trust selection by moving the
cursor, so stripping ANSI from accumulated text cannot identify the choice.
Only the service-owned empty working directory is trusted. Built-in tools
remain disabled and only this run's MCP server is allowed.

Images in the rendered prompt, native search, JSON Schema and text exceeding
400 KB retain print mode. Search stays on its existing permission protocol so
domain and max-use constraints cannot disappear. Missing PTY support or failed
interactive startup may fall back only before sending a user prompt. Both
fallback paths log their use of print mode; they never change to legacy HTTP.

`src/services/claude/cli/tui-events.ts` joins main tapped SSE with the session
transcript by message ID. Streamed replies suppress their persisted twin;
transcript fallback keeps every content block, including identical signed
thinking rows, and retains blocks appended after an earlier quiet interval.
An unidentifiable main stream uses transcript output instead of exposing a
background request. The helper removes its transcript after the PTY exits;
forced termination retains the existing transcript TTL cleanup as a backstop.

## Alternatives considered

Changing `CLAUDE_CODE_ENTRYPOINT` would only label a print run. Scraping rendered
answer text would lose tool arguments, signatures and token usage. Routing
native search through unrestricted interactive permissions would bypass caller
constraints. Installing node-pty as mandatory would break print-only Linux
installations without native build tools, so it is optional and loaded inside
the startup fallback boundary.

## Consequences

Existing accounts keep print mode. Interactive mode needs persistence while a
run lives and cannot use `--no-session-persistence`. Its main-stream tap is
version-dependent, with complete-block transcript output as the fallback.
The MIT-licensed magpie tap attribution is shipped with the build.

`tsdown.config.ts` must keep node-pty external: bundling its JavaScript moves
native-module and ConPTY-worker resolution into dist and silently forces every
built run back to print mode. It also copies the tap and MIT notice to dist.
Run the same PTY regressions against a build with
`COPILOT_API_TEST_CLAUDE_ENTRY=dist/main.js bun test tests/claude-cli-tui.test.ts`.

Regression coverage is in `tests/claude-cli-tui.test.ts` (real PTY input/output,
partial trust redraw, signed thinking, tool callbacks, mode isolation, startup
fallback and cancellation), `tests/account-update.test.ts`,
`tests/accounts-claude-cli-status.test.ts` and `tests/claude-cli-env.test.ts`.
`tests/admin-account-view-parity.test.ts` verifies the account API response,
subsequent listing and the persisted connection record agree on the mode.
