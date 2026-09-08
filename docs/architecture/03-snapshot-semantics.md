# Snapshot boundary

Call `snapshotBlock(actor, blockId)` through the domain service. The service authorizes access and materializes the current content into an immutable BlockRevision; immutable generated blocks reuse their final revision. Explicit Save brane flushes edits but does not create historical revisions just because geometry or a title changed. Explicit snapshot is available separately.

Run submission includes pending text edits and expected versions. A short SQLite transaction applies edits, resolves ordered references and optional conversation lineage, calls the snapshot service for mutable inputs, creates the Run and freezes revision IDs. Any conflict rolls back the entire submission. The provider receives reconstructed messages from these revisions only after the transaction commits.

Response chunks live in a bounded, periodically overwritten RunCheckpoint. Finalization atomically creates the response revision, RunOutput and conversation messages, then marks completed. Failure/cancellation/interruption retains partial text but does not promote it to a final revision.

A future CRDT implementation materializes a coherent document snapshot through the same domain service. It must define an acknowledged frontier for submitted edits before publishing a revision; callers must not bypass that service to query CRDT internals. Existing revisions and run inputs survive the migration unchanged.

Spawn submits source edits through this same transaction, serialized with client autosave. Source inputs are explicit and ordered; an artifact’s derivation ancestors are not implicitly included. The resulting child remains linked to the exact submitted revision even after the source is edited or its placement removed.
