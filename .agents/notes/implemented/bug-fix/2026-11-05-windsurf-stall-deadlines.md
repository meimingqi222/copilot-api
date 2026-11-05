# Agent Note: Windsurf deadlines cover the whole attempt and inter-event silence

Status: implemented

## Problem

CCS logs contained SWE-2 Flash calls taking about 60 seconds to reach HTTP 200,
followed by additional waiting. The first-frame timer formerly started only
after `createWindsurfAttempt` returned, excluding authentication and response
headers. It also stopped protecting the request after its first output. Both
streaming and collected Chat responses use this path. The logs do not establish
whether authentication, upstream headers, or connection reuse caused each delay.

## Decision

`src/services/windsurf/create-chat-completions.ts` creates the attempt lazily
inside the iterable primed by `src/services/windsurf/stream-start.ts`. The existing
first-frame deadline therefore includes auth, encoding, fetch retries, response
headers and first output. A per-attempt AbortController exists before auth starts
and cancels upstream I/O when either deadline expires.

`WINDSURF_STREAM_IDLE_TIMEOUT_MS` in `src/services/windsurf/config.ts` bounds
each subsequent wait for a forwardable event, not the entire response. It defaults
to 60 seconds; zero disables it. Reasoning and tool deltas count as output.
Timeout warnings identify pre-output versus stream-idle waits without recording
prompts or credentials. Preserve client cancellation and release account capacity.

Only first-output timeouts qualify for the existing opt-in same-account retry.
Idle timeouts never replay a partial response, even when the caller requested a
collected response and has not received that partial output yet.

`src/services/windsurf/diagnostics.ts` emits ordinary info-level phase transitions,
first bytes/frame, EOS and a terminal summary with a shared request ID and attempt
number. Auth, session setup, encoding, fetch/header waits, HTTP error-body reads,
retry delays and model-output waits remain distinguishable. Byte reads, complete
frames and forwarded content/reasoning/tool events are counted separately; only
counts and timing are recorded, never payloads, credentials or raw error text.
Progress updates do not log per delta. Cancellation, timeout, error and completion
are separate terminal outcomes. Diagnostics still work when deadlines are disabled;
they report observed phases, not a verdict that connection reuse caused a stall.
Mark completion before yielding `[DONE]`: the Chat SSE consumer closes the iterator
at that event, so code after a delegated yield may never run. Closing after DONE
is successful completion, not caller cancellation.

## Alternatives considered

Keep timing only after HTTP 200: this cannot bound the waits visible in CCS logs.
Use one total-duration limit: valid streams can run for a long time while making
progress. Retry after partial output: this can duplicate tool calls or responses.
Disable keep-alive globally: connection reuse has not been proven to cause the
reported upstream stalls.

## Consequences

This bounds our waits; it does not promise the upstream will answer successfully
or within a client's shorter deadline. A client with a 30-second timeout needs a
smaller server budget (including time for failover), not the 60-second defaults.
No CCS settings or service deployment are changed by this patch.

## Verification

- `tests/windsurf-first-frame.test.ts::bounds ${stage} stalls and frees the account`
  exercises auth, headers, error bodies, first output and partial-output stalls in
  both modes, including partial frames and metadata-only frames. It checks phase
  logs, no sensitive text, cancellation, no partial-response retry, and recovery.
- `tests/windsurf-first-frame.test.ts::counts reasoning and tools without per-delta or content logs`
  checks successful info-level summaries, exact byte/frame/event counts and
  bounded log volume in both modes, including a consumer that stops at DONE.
- `tests/windsurf-first-frame.test.ts::records auth failure without a deadline or sensitive error text`
  checks failures are diagnosable with the deadline disabled.
- `tests/windsurf-first-frame.test.ts::records caller cancellation separately from provider deadlines`
  checks caller cancellation is not logged as a provider timeout.
- `tests/windsurf-first-frame.test.ts::shared HTTP client recovers after header/body stalls in both modes`
  uses a real loopback HTTP upstream and one Bun fetch client, including Connect
  EOS with a body kept open. It is not a live vendor reliability benchmark.
- `tests/windsurf-stream-start.test.ts::idle deadline resets per event, not per response`
  checks progressing responses outlive the idle budget and that zero disables it.

Proved: Before the fix, auth/header stalls escaped the first-frame deadline and
partial-output stalls escaped all provider deadlines. Six parameterized timeout
cases failed with the caller's fallback timeout instead of the expected provider
error; two additional EOS decoder cases failed while waiting for HTTP EOF.
The pre-fix output is retained in
`.agents/notes-evidence/windsurf-deadline-red.log`.

Proved: Stopping the streaming consumer at DONE on commit 6e81214 failed the
existing successful-summary assertion (`cancelled` instead of `completed`);
the same evidence file retains the focused red-run excerpt. The equivalent
collected case passed, distinguishing consumer closure from upstream failure.
