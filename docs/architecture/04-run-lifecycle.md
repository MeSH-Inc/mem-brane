# Run lifecycle

queued → claimed → running → completed | failed | interrupted

queued/claimed/running → cancel_requested → cancelled

Submission atomically freezes inputs and creates a queued Run under a per-user idempotency key. An identical duplicate returns the original Run; a changed payload conflicts. A worker atomically selects and conditionally claims queued work in a short transaction, acquiring a lease. Before the external call it persists running and creates a RunAttempt. Provider I/O is outside transactions.

Heartbeat renews the lease. Stale claimed work can return to queued because no invocation was started. Stale running work becomes interrupted: external completion or billing may be uncertain. Stale cancellation becomes cancelled. No exactly-once external execution is claimed.

Concurrency is configurable globally and per user. Chunks are multiplexed via SSE and periodically checkpointed by time/character threshold. Finalization publishes immutable output and usage atomically. Explicit cancellation aborts local provider work best-effort; it cannot promise zero billing. Shutdown stops claiming, aborts active work and records interrupted unless user cancellation was requested. On restart stale leases are recovered conservatively.

Retry is explicit: a new Run carries retry_of and copies frozen inputs, with a new idempotency key and attempt. It never silently substitutes newly edited content. Browser disconnect has no cancellation semantics. SSE reconnect reloads all relevant persistent runs and checkpoints; event replay is unnecessary for correctness.

## Execution supervision

A provider result is final only after an explicit successful finish. Premature EOF,
provider errors, and output-limit truncation preserve checkpoints without creating an
output revision. Their billing remains uncertain.

Runs have a total deadline (default five minutes) and an idle deadline (default one
minute). Asset reads receive the cancellation signal. The worker stops waiting even
if an adapter ignores cancellation; late chunks and late results cannot update SQL.
Infrastructure failures stop admission and trigger an unsuccessful process shutdown.
Shutdown closes event streams, drains HTTP requests and interrupts workers before
closing SQLite. A twenty-second process deadline bounds an unresponsive shutdown.
