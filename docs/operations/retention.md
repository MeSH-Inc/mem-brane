# History retention policy

Artifact identity, immutable revisions, frozen run inputs/outputs, conversation
lineage, cost reservations and reconciliation evidence are retained indefinitely.
Removing a placement does not delete any of these records. Age alone never proves
an artifact or financial record is disposable.

Every minute, a bounded transaction removes up to 100 rows from each of these
operational categories:

- Completed checkpoints older than seven days, only when a corresponding immutable
  output contains exactly the same text and billing is confirmed or released.
- Expired authentication sessions and verification records.

Failed, cancelled, interrupted, active, unmatched and uncertain-billing checkpoints
remain available. Cleanup never drops immutability triggers. The checkpoint age is
configured by `COMPLETED_CHECKPOINT_RETENTION_DAYS` (minimum one day). Expiry indexes
avoid repeated scans of live authentication rows. Cleanup failure triggers the same
supervised shutdown as other database infrastructure faults.

SQLite can reuse pages freed by cleanup; this is not automatic file compaction.
Do not run VACUUM on the request-serving connection. This policy intentionally does
not bound the total size of authored history: the disk admission floor prevents new
writes before exhaustion. Explicit user deletion or archival requires a future
provenance-aware policy and a verified backup before physical removal.

Backup bundles and off-host rehearsal receipts are retained until explicit operator
removal. This round does not install an automatic remote deletion job. The remote
rehearsal directory contains synthetic fixture data only. For future production
backup rotation, establish the recovery-point objective and required history before
automating deletion of verified copies.
