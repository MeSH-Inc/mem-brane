# Extraction reuse, PDF reads and legacy consolidation — September 8, 2026

This round implements the three recommendations from
[asset normalization](asset-normalization.md):

- `7a3e335` reuses extraction results by explicit parser policy.
- `18a141c` separates PDF workspace summaries from frozen page reads.
- `72162ce` consolidates legacy duplicates with verified backups and resumable cleanup.

## Extraction policy and read boundaries

Policy identities include parser versions, implementation version, parser options
and enforced limits. PDF workers receive the declared options and limits; image
policies include the Sharp/libvips versions. Results map an owner-scoped asset and
policy to an immutable representation. A changed policy produces a new identity
even if its extracted text happens to match. Existing revisions keep their identity.
Successful cached imports still verify original object bytes. Thrown parser errors do not become
permanent cached results; successful unavailable-text outcomes can be reused.

Concurrent imports with the same owner, digest and policy serialize within the
application's database handle. Published results persist across service restarts.
This is the existing single-server concurrency model; it does not claim to coalesce
parsers across independently running server processes.

A database-maintained summary projection excludes PDF pages from workspace reads.
The `PdfSummary` type keeps representation ID, original asset metadata, filename,
page count and compatibility status. The UI loads page text on demand from the
owner-authorized `/api/representations/:id/pages` endpoint. Late responses for an
obsolete identity are ignored and failed reads can be retried. Provider execution,
estimates and frozen revision reads continue to expand their pinned page content.

## Measured fixture

The [raw probe](asset-read-scaling.json) imports a deterministic noise PNG and a
five-page PDF 20 times each, then snapshots all 40 artifacts. It uses the actual
parsers and requires complete PDF evidence. Results:

| Quantity                                      |        Result |
| --------------------------------------------- | ------------: |
| Image / PDF parser invocations                |         1 / 1 |
| Artifacts / revisions                         |       40 / 40 |
| Assets / representations                      |         2 / 2 |
| Workspace JSON with summaries                 |  30,545 bytes |
| Equivalent workspace JSON with expanded pages | 170,025 bytes |
| Stored original bytes                         |  47,095 bytes |
| Verified content references                   |            80 |

Workspace transfer is about 82% smaller for this repeated-PDF fixture. This measures
UTF-8 JSON and parser invocation counts, not general workload latency, process
memory or SQLite allocation. The expanded comparison reconstructs current content
on the same graph. Image metadata, placements and run metadata remain in both.

```sh
NODE_ENV=test node --import tsx scripts/asset-scaling.ts /tmp/asset-read-scaling.json
```

## Offline legacy workflow

The CLI operates on a local object directory and a database after migration 014 but
before 015. It does not guess missing hashes, repair conflicting MIME metadata or
recover unreferenced assets. Those cases stop preflight. Run it only with the server
stopped and outstanding object writes settled; `--offline` acknowledges that state.
No live database or remote object store was modified during this development round.

```sh
node --import tsx scripts/consolidate-assets.ts plan --offline \
  --database /absolute/db.sqlite --assets /absolute/assets
node --import tsx scripts/consolidate-assets.ts apply --offline \
  --database /absolute/db.sqlite --assets /absolute/assets \
  --backup /absolute/new-legacy-backup
DATABASE_PATH=/absolute/db.sqlite npm run db:migrate
node --import tsx scripts/consolidate-assets.ts cleanup --offline \
  --database /absolute/db.sqlite --assets /absolute/assets \
  --backup /absolute/new-legacy-backup
```

Preflight checks all original bytes against metadata and frozen references, then
chooses the lexically first asset ID per owner/digest. Equal bytes across owners
remain separate. Apply creates and verifies a private backup with the original
SQLite database and all original objects. It checks that the database still matches
that backup, rewrites only asset identities in live content, revisions and receipts,
and journals redundant storage keys in one exclusive transaction. Revision IDs,
text, placements and request hashes remain unchanged. Apply does not delete bytes.

A crash before commit leaves the original graph intact. Retrying apply reuses an
existing fully verified matching backup; an incomplete backup needs a fresh backup
directory. After commit, continue with migration and cleanup. Cleanup verifies both
the original backup and current restoration integrity before removing redundancy.
It journals deletion progress, tolerates lost delete acknowledgements, and can clear
obsolete reservations in a restored bundle that contains only canonical objects.
Redundant bytes remain charged to quota until deletion or absence is acknowledged.

Tests restore both the original backup and a migrated canonical-only bundle. They
compare provider messages, check owner isolation, exercise rollback and crash points,
and reject corruption of originals, backups and canonical objects before deletion.

Full `npm run verify` passed formatting, type checking, build, **198 tests** and
**18 browser tests**. The final binary/PDF probe independently verified all 80
content references.

## Recommended next round

1. Batch representation resolution for workspace and context reads. Load each distinct
   identity once per request, reuse decoded values, and measure query counts with
   hundreds of artifacts sharing a small set of representations. Preserve ownership
   checks and exact provider-message expansion.
2. Give revision-history pages summary projections, with full content fetched only for
   the selected revision. Verify large PDF histories stay bounded in response bytes
   and initial UI memory, while inspection still opens the exact frozen revision.
3. Make backup verification report outstanding cleanup liabilities explicitly. Cover
   recovery of canonical-only bundles without requiring operators to infer journal
   state, and retain the verified-backup gate before any object deletion.

The recommended work above is complete. See the
[data-layer checkpoint](data-layer-checkpoint.md) for final measurements, backup
report semantics, stopping points and recommended product pivots.
