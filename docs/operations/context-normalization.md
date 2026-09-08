# Context normalization results — September 8, 2026

The follow-up separates workspace state from historical runs and replaces copied
ancestor inputs with sealed context manifests. Historical lineage/reference JSON
and the flattened `run_inputs` table are removed. Retries share a manifest; each
conversation message identifies its originating run. The migration checks the
entire expanded legacy sequence before dropping the old representations.

## Measured results

| Conversation turns | Previous stored input rows | Stored context entries | Expanded inputs for final run |
| ------------------ | -------------------------: | ---------------------: | ----------------------------: |
| 10                 |                        110 |                     11 |                            20 |
| 40                 |                      1,640 |                     41 |                            80 |
| 80                 |                      6,480 |                     81 |                           160 |

For this fixture, stored entries grow as `n+1` rather than `n(n+1)`. The 80-turn
case stores 98.75% fewer input entries while preserving the same expanded request.
Manifest, run, message and revision records also consume space; this percentage
does not describe total database savings or provider token savings.

The repeated full history-capacity exercise retained 120 distinct 20,000-character
versions, the 80-turn chain and 250 independent historical runs with removed output
placements. Live SQLite page allocation after seeding history was **4,411,392
bytes**, versus **5,607,424 bytes** in the earlier fixture. After visible content
and the measured queue it was 8,835,072 bytes. Allocations include indexes and
metadata but exclude WAL/SHM and backups; UUID placement and page packing can vary.

All 40 workspace HTTP requests succeeded, all eight queued mock runs completed,
and overflow admission was rejected. Workspace responses were 4,071,787 bytes,
because removed historical runs no longer ride along with visible state. HTTP p95
was 91.2 ms, peak sampled server RSS 337.5 MiB, and queue wait p95 25.1 seconds.
These single development-host runs establish no latency improvement; the retained
visible text still dominates transfer and serialization. Revision pages remained
504,088 bytes, with 4.0 ms p95 across 20 sequential reads after queue drain.

The separate 80-versus-2,580-removed-output probe passed again after normalization:
visible/active run reads used 168 VM steps, visible derivations 92, and the first
run-history page 398 at either size. See [read scaling](run-read-scaling.md) for
the method and its limits.

Raw results: [capacity](capacity-contexts.json),
[post-normalization read scaling](read-scaling-contexts.json), and the
[earlier history fixture](capacity-history.json). Reproduce with:

```sh
npm run build
NODE_ENV=test node --import tsx scripts/capacity.ts /tmp/capacity-contexts.json 8 20000 1024 history
NODE_ENV=test node --import tsx scripts/read-scaling.ts /tmp/read-scaling-contexts.json
```

## Verification and next commits

Full verification passed: formatting, build, 176 tests and 18 browser tests.
Coverage includes byte-for-byte-equivalent JSON provider messages across migrated
branches, user-message continuation, image references, multi-source derivation and
retry; migration rollback on conflicting history; sealed-entry immutability;
ownership and message-origin constraints; linear storage; unchanged estimates;
and the 200-message ancestor boundary.

The next recommended round is the asset/representation refactor already outlined
in [data efficiency](data-efficiency.md):

1. Make asset digest, MIME type and byte length canonical immutable metadata, with
   owner-scoped byte deduplication. Verify distinct import keys still create distinct
   artifacts while sharing bytes, ownership remains isolated, and quotas account
   for both stored bytes and uncertain upload reservations.
2. Store extracted representations independently and pin their identities from
   live content and revisions through foreign keys. Keep extraction job state
   separate. Verify a newer extraction cannot alter old provider context, and
   restoration detects missing or mismatched referenced representations.
3. Replace full import-result JSON with compact creation receipts. Verify uncertain
   retries acknowledge the same block and placement without restoring old geometry.
   Add binary/PDF fixtures before claiming storage or memory improvements.

The asset/representation round above is now implemented. See
[asset normalization results](asset-normalization.md) for commits, binary/PDF
measurements, verification, migration limits and the next recommended round.
