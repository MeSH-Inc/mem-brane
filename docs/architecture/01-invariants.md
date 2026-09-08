# Architectural invariants

## Identity and content

- Brane, Block, Placement, Revision and Run IDs are opaque application identities, independent of React Flow, database row order, CRDT internals and sessions.
- A Block is a semantic artifact, reusable across branes and multiple placements in the same brane. Removing a placement never deletes its block; block deletion requires a separate explicit operation.
- Binary bytes live outside SQL. Blocks reference asset metadata.
- A Block has zero or one LiveState, depending on kind. Text is editable; webpage content is ingestion-managed; images have metadata; responses use Run checkpoints while active and immutable revisions on completion.

## Live state and snapshots

- LiveState is mutable current editing state, never historical truth. React Flow and Zustand are not canonical content stores.
- LiveState may later be a CRDT document. Callers use domain mutation and snapshot boundaries, not storage-specific HTTP assumptions.
- Revisions are immutable materialized snapshots. New edits never mutate old revisions or submitted runs.
- Submission resolves explicit context, applies flushed edits, materializes revisions and freezes ordered revision IDs atomically before queueing execution.

```text
LiveState → snapshot/materialize → Revision → RunInput
```

- Provider execution reads frozen RunInputs, never newer LiveState. Recorded requests can be reconstructed; stochastic provider output is not guaranteed reproducible.

## Placements and client persistence

- Geometry and brane membership belong to Placement, never BlockRevision.
- Moving or resizing neither creates revisions nor alters context. Pointer frames remain local; persist meaningful completed gestures through domain services.
- Text saves are debounced. Submission includes pending edits and expected versions to avoid saving or snapshotting stale content.
- Persisted state is server-authoritative; local drafts, selection, viewport, inspector and gesture state are transient.

## Context and conversation

- Context is explicit, ordered and inspectable. Selection, proximity, grouping and layout never imply inclusion.
- `continue from here` follows the selected message's ancestor lineage. `use as context` imports labeled references. These are structurally different operations, never generic edges.
- Combining independent outputs uses labeled reference material, never fabricated chronological dialogue.

## Runs and cost

- Every generation has a persistent Run, frozen request, model/options, timestamps, lifecycle, usage when available and finalized output revision IDs.
- Browser navigation never intentionally cancels work. The server owns execution beyond HTTP request lifetimes.
- Submission keys deduplicate requests per user. Changed payload under the same key is rejected.
- Claiming is atomic; leases are heartbeated. Stale claimed work can be requeued before invocation. Stale running work is interrupted and is never automatically billed again.
- Explicit retry creates a new Run linked to its predecessor, preserving frozen context.
- Partial checkpoints are not finalized revisions. Stream often, checkpoint in batches; no token rows or network calls inside write transactions.
- Output limits, model allowlist, global concurrency and per-user active limits are server-enforced. Estimated and confirmed usage remain separate. Paid admission reserves a conservative cost bound atomically, requires verified pricing and a positive daily budget, and includes unresolved liabilities from earlier days. Usage-rated costs and provider invoices are distinct.

## SSE and collaboration

- One authenticated browser stream multiplexes run events. SSE is a hint, not storage. Reconnect reloads persistent authoritative state, including checkpoints and completed output.
- CRDT document IDs must not replace product IDs. Future mutation can replace LiveState persistence behind domain services without changing Block/Brane/Placement/Revision/Run meanings.
- Presence (cursor, selection, currently editing, viewport, display metadata) is ephemeral, separate from persistent content, and excluded from revisions.
- Mobile uses focused reading/editing, tap-to-add and navigation; desktop canvas parity is not required.
