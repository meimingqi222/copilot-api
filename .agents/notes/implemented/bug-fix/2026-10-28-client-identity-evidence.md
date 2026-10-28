# Agent Note: Client identity comes from headers and the system prompt

Status: implemented

## Problem

Amp requests appeared on the redaction graph under `OpenCode`. Amp sends
`User-Agent: Amp-CLI/0.0.1793174452-gd75e9a`, which matched no entry in
`KNOWN_AGENTS`, so `inferClientAgent` fell through to `matchPayloadAgent`.

That fallback serialized the entire request body with `JSON.stringify` and ran
`/opencode/i` over it. Every message was searched, including the user's own
text. A conversation that merely mentioned OpenCode — a question about which
clients the proxy supports is enough — was attributed to OpenCode. The same
scan could report `Aider`, `Devin`, `Claude Code` or `Cursor` from a passing
mention, and any client with an unrecognized user agent was affected.

Amp was not the only gap: nothing recognized it, and the
`ai-sdk-openai-compatible` user agent was likewise unrelated evidence.

## Decision

`src/lib/client-agent.ts` identifies a client only from evidence the client
itself supplies:

- Header markers — `x-amp-client-type`, `x-amp-installation-id`,
  `x-opencode-*`, `x-claude-code-session-id`, and the explicit `x-client-*`
  headers — are checked first.
- `KNOWN_AGENTS` matches the user agent. `Amp` is anchored to a leading
  `amp-cli/` or `amp/` token so a UA that merely contains the word does not
  count.
- `selfDescription()` replaces the whole-body scan. It reads only the system
  prompt (`system`, `instructions`, and `system`/`developer` messages),
  following nested text blocks. This is the one place a client states "You are
  OpenCode…", so a match there is evidence about the client rather than about
  the conversation.

Reading only the system prompt is what keeps the fallback useful for clients
with generic user agents without letting user-authored words decide identity.

## Alternatives considered

**Keep the whole-body scan and add Amp to `KNOWN_AGENTS`.** It fixes the
reported label but leaves the misattribution mechanism intact for every other
client, so the next unrecognized user agent reproduces it.

**Scan only the first message.** Multimodal and Responses payloads reorder and
split content; the first message is not reliably the system prompt.

**Drop payload inference entirely.** Clients that send a generic user agent
would then be labeled `Unknown client`, losing the identification the system
prompt legitimately supports.

## Consequences

A client whose only self-identification lives in a non-system message is no
longer detected from the payload; it falls through to the user agent and SDK
rules. A system prompt that mentions a different tool (for example, a proxy's
own instructions describing supported clients) can still mislabel, but that
text is client-authored rather than user-authored.

## Verification

- `tests/client-agent.test.ts`
- `tests/client-agent.test.ts::a conversation mentioning another tool does not become that tool`
- `tests/client-agent.test.ts::identifies Amp from its headers and user agent`
- `tests/client-agent.test.ts::reads self-description from Anthropic-style system blocks`

Proved: with the old whole-body scan, a request carrying the Amp-CLI user
agent and a user message asking about OpenCode returned `OpenCode`; the test
above failed as expected. Red run saved in
`.agents/notes-evidence/client-identity-red.log` (8 pass / 2 fail before, 10
pass / 0 fail after). A generic user agent with "You are OpenCode" in the
system prompt still returns `OpenCode`, and Anthropic-style `system` text
blocks are read. Verified end to end against a running server and a stub
upstream: 23 Amp requests appeared as `Amp` on the graph while 5 Codex requests
stayed `Codex`, with no `OpenCode` lane.
