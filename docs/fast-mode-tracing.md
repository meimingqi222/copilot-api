# Codex Fast-mode tracing

New request traces distinguish the client's `service_tier`, the value after route
overrides, the normalized tier supplied to the upstream transport, and the tier
explicitly reported by the final upstream response. Initial lifecycle frames do
not confirm a tier. Codex normalizes implicit/default
tier to no wire field; traces label this as `default`. Both `fast` and `priority`
request Fast; the Codex transport maps `fast` to `priority`, matching the official
client's `ServiceTier::Fast.request_value()`. OpenAI Chat/Responses translation
preserves `fast`, and trace fields retain raw values. The UI compares the two
spellings as the same mode, so `priority` sent with `fast` reported confirms Fast.

The request list, execution-mode summary above the timeline, and each dispatch
attempt share plain-language labels. `priority` sent with `default` reported is
shown as “请求 Fast → 上游回报普通模式”, not as confirmed Fast. Only a final
`priority` or `fast` report confirms Fast. A live send awaits confirmation; a completed
request without a mode report stays unconfirmed, never indefinitely waiting.
Client-requested Fast without a send record is distinct from Fast sent upstream.
Raw protocol fields are available in the expandable details and row tooltips.

Recent, history, session and SSE trace projections retain all four tier fields.
Old completed rows may use the last matching attempt's sent/reported pair, never
an earlier retry or a mixture of attempts. In-flight requests do not fall back to
finished attempts. Missing fields are not fabricated as `default`, and model
names or timing never imply Fast.

Both HTTP and WS sends record their final body tier, including WS full-replay
fallback. Stream observation preserves the original frames and cancellation.
Only frames containing the service-tier field are parsed for this observation.

HTTP routing hints and fresh WebSocket handshake hints use the resolved upstream
model and tier (`model=<native model>;tier=priority` for Fast), rather than a
forwarded client alias or pre-routing tier. This hint is advisory; the request
body controls the tier. The official client also reuses a WebSocket after its
initial advisory handshake, so changing tiers does not force a socket redial.

The source comparison used local Codex revision `b741e480e2`:
`codex-rs/protocol/src/config_types.rs`, `codex-rs/core/src/config/mod.rs`,
`codex-rs/protocol/src/openai_models.rs` and `codex-rs/core/src/client.rs`.
The official client gates tier selection by its model catalog; a proxy send alone
does not prove the selected account is entitled to Fast. A final upstream
`default` report remains a normal-mode report, not a confirmed Fast response.

Debug log entries contain tier and request ID only and use the global application
logger. Trace metadata remains available when detailed performance timings are
disabled. No new raw request dump or unconditional console output is introduced.
