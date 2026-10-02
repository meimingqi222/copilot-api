# Usage and quota refresh

The Usage and Quotas pages poll cached admin data only while visible. Each page
defaults to five seconds and offers Off, 5, 10, 30 and 60 seconds, persisted in
the browser. Pricing editors pause polling. Automatic reads do not show loading
screens or success toasts, and unchanged usage does not redraw the chart.
Page update time is separate from each account's upstream quota snapshot time.

The server checks enabled account-managed connections every minute, even with
no admin browser open. Providers supporting quota refresh are probed every five
minutes; Claude uses fifteen minutes to reduce pressure on its private endpoint.
Existing recent snapshots are reused. Balance synchronization retains its
five-minute cadence. Unsupported and disabled accounts are not probed.

The manual quota refresh endpoints share the same per-connection in-flight work
and use a thirty-second minimum interval. Failures preserve the previous reading
and throttle background retries. Quota probes receive a twenty-second abort
signal; background account probes are limited to four concurrent operations.

Quota snapshots and reset windows are inputs to quota-aware routing within its
existing priority and compatibility policy. Local served-token counters are
separate inputs to least-used selection. Refreshing updates the credential's
quota snapshot and availability through its existing provider runtime; request
selection remains synchronous and performs no upstream quota I/O.

This is periodic observation, not an exact per-request deduction: upstream
quota accounting may lag, and usage from other clients is visible only after a
successful probe. Existing request-time rate-limit/failover handling still applies.
