# Agent Note: Coding client dialects at the IR boundary

Status: implemented

## Problem

Responses clients replay custom calls, client tool search, Lite tool declarations,
configuration updates and compaction records. Treating these as unknown input
blocks prevents failover to Chat and Messages accounts. A Lite `additional_tools`
item also carries a developer role; testing role before item type silently loses
its declarations. Messages clients replay PDF documents and opaque thinking,
which must not fall into generic tool-result or tool-call branches.

## Decision

Normalize client dialects in `src/services/ir/codecs/responses/request.ts` and
`src/services/ir/codecs/responses/codex-input.ts`, before target encoding. Lift
Lite and discovered tools with stable names; unwrap Lite's `functions` namespace
in declarations, history and tool choices together. Only actual message items
are interpreted by role. A late instruction remains an in-place user reminder.

`IRTool.responsesType` and `IRToolCallPart.responsesType` retain the Responses
client's custom/search identity across a Chat, Messages or Gemini upstream.
Custom tools become one-string-input functions; output restores free text and
streams decoded input prefixes, withholding incomplete JSON escapes. Client
tool search restores its object arguments on the completed item.

`src/services/ir/codecs/messages-chat/messages-content.ts` switches explicitly on
runtime block types. PDF documents become IR files, including within tool
results. Responses preserves them; Chat and other targets without file support
reject during preflight. Messages user turns containing tool results are split
into Responses output items without moving surrounding text.

`RequestIR.decodeLosses` records omitted optional/opaque blocks and hosted tool
declarations. `planTranslation` adds the target and decode stage, using the
existing loss telemetry. Records contain paths and reasons, never payloads.
Malformed known calls/media still reject; compaction triggers and unsatisfied
required/named tools are never downgraded to ordinary text requests.

## Alternatives considered

Reject every unfamiliar historical item: this prevents entire ongoing coding
conversations from using otherwise compatible accounts. Preserve arbitrary JSON
on the wire: each target has different semantics and may reject it. Drop unknown
items without telemetry: operators cannot distinguish a compatible conversion
from missing context. Flatten custom calls without retaining their kind: the
client receives a function call it cannot execute.

## Consequences

Native same-wire adapters keep their own pass-through behavior. Translation
cannot decrypt OpenAI compaction or Anthropic redacted thinking, cannot run hosted
tools on unrelated providers, and cannot enforce a custom grammar at the target;
the grammar is included in the function description. These boundaries do not
authorize invented ciphertext, signatures or silent removal of required files.

Coverage: `tests/ir-responses.test.ts`, `tests/ir-messages-chat.test.ts`, including
custom/search calls through a Messages executor in both response modes, Lite
developer-role items, ordered PDF tool results, loss metadata and preflight
rejection before a Chat executor is called.
