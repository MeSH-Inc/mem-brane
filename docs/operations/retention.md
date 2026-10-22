# History retention policy

For retained libraries, artifact identity, immutable revisions, frozen run inputs/outputs, conversation
lineage, cost reservations and reconciliation evidence are retained indefinitely.
Removing a placement does not delete any of these records. Age alone never proves
an artifact or financial record is disposable.

At startup and every minute, a bounded transaction removes up to 100 rows from each of these
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

Unclaimed guest work has a separate lifetime: after its configured expiry and the
seven-day claim recovery grace, maintenance reclaims up to 100 guest libraries per
batch. Claim and purge decisions serialize in immediate transactions. Claimed
libraries are retained. Active file imports and queued/running ingestion postpone
cleanup; later eligible guests can still progress. Guest capabilities exclude
model work, but any unexpected library with run, conversation, context or
spend history is retained for investigation, including settled billing
evidence.

Reclamation atomically marks the guest as purged, revokes its sessions and claim
intent, deletes its content graph and moves original assets, abandoned upload
reservations into a durable deletion queue.
The schema allows revision and representation deletion only for purged,
unclaimed guests; it never drops history guards at runtime. Minimal guest, library
and principal tombstones remain so ownership and the irreversible purge decision
are preserved. Request bodies that finish after reclamation must recheck their
destination before reserving or publishing an import. The upload fence relies on
the supported single API process and shared database connection; multiple API
writers would require durable cross-process upload coordination.

Storage bytes remain charged until the object store acknowledges deletion or
explicitly reports the object missing. At most 100 objects are attempted per batch;
failed attempts persist exponential retry delays from one minute to one hour,
without blocking later due objects. Each deletion batch has a 30-second deadline;
unattempted objects remain due for the next batch.
Shutdown cancels storage requests and drains maintenance before closing SQLite.
Lost acknowledgements and process restarts safely retry deletion. Structured
`guest_cleanup` logs report reclaimed libraries and successful/failed object
deletions; database failures trigger supervised shutdown, while storage failures
retain their deletion debt for retry.

The scheduled remote backup job automatically removes its dated production archives
older than fourteen days, only after uploading a new archive, reading it back and
verifying its checksum. It restricts deletion to recognized archive names under
`mem-brane/production/`; unrelated objects are retained. Existing daily archives
skip that run's upload and rotation. Locally exported bundles and off-host rehearsal
receipts remain until explicit operator removal. The remote rehearsal directory
contains synthetic fixture data only. Review the required recovery window before
changing the production rotation policy.
