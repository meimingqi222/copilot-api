# Codex Fast-mode tracing

New request traces distinguish the client's `service_tier`, the value after route
overrides, the normalized tier supplied to the upstream transport, and the tier
explicitly reported by the final upstream response. Initial lifecycle frames do
not confirm a tier. Codex normalizes implicit/default
tier to no wire field; traces label this as `default`. Fast maps to `priority`.

The list shows `Fast` only as confirmed when the response reports `priority`.
A sent `priority` without a response tier is labeled unconfirmed; a different
reported tier is shown as a mismatch. Each dispatch attempt retains its own sent
and reported values. Old trace rows do not infer Fast from model names or timing.

Both HTTP and WS sends record their final body tier, including WS full-replay
fallback. Stream observation preserves the original frames and cancellation.
Only frames containing the service-tier field are parsed for this observation.

Debug log entries contain tier and request ID only and use the global application
logger. Trace metadata remains available when detailed performance timings are
disabled. No new raw request dump or unconditional console output is introduced.
