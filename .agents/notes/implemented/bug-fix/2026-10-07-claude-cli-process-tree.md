# Agent Note: Terminate the Windows Claude CLI process tree

Status: implemented

## Problem

Windows npm installations launch Claude through a batch wrapper. Killing only the wrapper left its CLI child alive during hung or cancelled requests. Post-suite inspection found orphan fixture processes even though API cancellation and registry cleanup assertions passed.

## Decision

`src/services/claude/cli/process.ts` invokes taskkill with the exact subprocess PID and tree termination before falling back to the subprocess handle. The parent must stay alive until taskkill inspects its descendants. Failures are logged and retain the direct-kill fallback. `src/services/claude/cli/bridge.ts` uses this helper for cancellation, timeout, eviction and registry cleanup. Completed runs do not schedule termination twice.

## Alternatives considered

Closing stdin alone cannot end a CLI hung inside an operation. Killing the wrapper first destroys the ancestry taskkill needs. Enumerating all processes by executable name risks terminating unrelated CLI sessions; termination is scoped to the run's known PID.

## Consequences

Windows cancellation now terminates the wrapper and its descendants. Other platforms retain direct subprocess termination. The fixture uses the same batch launcher as the bridge and reports the child PID before deliberately hanging; the test checks actual child liveness rather than only registry state.

## Verification

- `tests/claude-cli-process.test.ts::terminates the launcher and its live CLI child`

Proved: temporarily bypassed the Windows tree-termination branch and ran the bound test. The child-liveness assertion failed with Expected false / Received true after the wrapper exited. Restored the branch and reran the same test successfully. Sanitized red output is saved in `.agents/notes-evidence/claude-cli-process-tree-red.log`.
