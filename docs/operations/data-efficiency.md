# Data efficiency follow-up — September 8, 2026

This round reuses immutable snapshots by live-state version, preserves versions on
unchanged saves, returns explicit workspace fields, avoids repeated completed
checkpoint text, and paginates revision history. Revision and frozen-input DTOs
contain parsed content without a duplicate serialized copy. Query indexes support
revision pagination and output lookup. Full workspace content loading remains.

## Local capacity evidence

Both exercises used Node 24.13.1 on the development Mac with 200 placements of
20,000 characters, four parallel readers making 40 HTTP requests, and two mock
workers draining eight runs with a 1,024-token output limit. The extended fixture
also seeds 1,000 unchanged snapshots, 120 distinct historical versions, an 80-turn
conversation, and 250 independent completed runs. All 330 historical output
placements are removed before the workspace is filled with visible content.
Historical work uses a deterministic executor before measurement; queue metrics
include only the eight subsequently admitted mock runs.

| Measurement                      | Without history | With history |
| -------------------------------- | --------------: | -----------: |
| Workspace response bytes         |       4,071,787 |    4,101,186 |
| Workspace HTTP p95               |         56.3 ms |      72.4 ms |
| Peak sampled server RSS          |       326.2 MiB |    323.4 MiB |
| Maximum sampled event-loop delay |         37.6 ms |      51.8 ms |
| Queue wait p95                   |          25.1 s |       25.2 s |

All 40 workspace reads succeeded in each exercise, all eight admitted runs
completed, and placement overflow was rejected. These are single local fixture
runs on an active development machine, not evidence of a statistically significant
latency or RSS improvement. The historical fixtures do not measure live providers,
binary imports, network latency, browser rendering or a sustained workload.

The unchanged 1,000 snapshots produce **one revision containing 20,027 bytes**.
Without reuse, those calls alone would materialize 20,027,000 content bytes; this
comparison is arithmetic, not a second timing run. SQLite live page allocation
increased by 32,768 bytes during source creation and those snapshots together.

For the 120-version history, the first 25-item HTTP page is **504,088 bytes** with
9.6 ms p95 across 20 sequential reads after the run queue drained. Reconstructing
the previous unpaginated, double-content response on the same fixture produces
4,825,681 bytes: the initial transfer is 89.6% smaller. Loading all pages still
transfers all requested content, once per revision. The comparison combines
pagination and removal of duplicate serialization.

Live SQLite page allocation reached 5,607,424 bytes after seeding history and
10,027,008 bytes after adding visible blocks and completing the measured queue.
These figures include indexes and metadata but exclude WAL/SHM files and backups.

Raw results: [without history](capacity-efficient.json) and
[with history and query plans](capacity-history.json). Query plans capture SQL and
parameters from the actual service calls on a separate read-only connection.
Revision pages use `revisions_history`, including the tuple range for subsequent
pages. Generated block reads use indexed run/output/revision lookups. The planner
still starts derivation reads from the owner's runs, and workspace run selection
still visits a brane's historical runs. Those paths remain growth-sensitive.

Reproduce sequentially after building:

```sh
npm run build
NODE_ENV=test node --import tsx scripts/capacity.ts /tmp/capacity-efficient.json 8 20000 1024
NODE_ENV=test node --import tsx scripts/capacity.ts /tmp/capacity-history.json 8 20000 1024 history
```

`NODE_ENV=test` suppresses fixture seed lifecycle logs; the spawned measurement
server explicitly uses development mode. Both exercises create disposable data.

## Recommended next commits

1. Separate visible/active run retrieval from paginated run history. Drive visible
   derivation lookup from placed output IDs. Extend the fixture to thousands of
   removed outputs and require visible-read query work to stay proportional to
   visible records. Keep full-text lazy loading as a distinct API/client change;
   the roughly 4 MB workspace response is still dominated by visible text.
2. Normalize conversation turns and their reference relationships. The measured
   chain contains 110 input rows at 10 turns, 1,640 at 40, and 6,480 at 80. This is
   `n(n+1)` for this fixture. Store immutable parent-linked context manifests with
   ordered additions, and associate each turn with its originating request.
   Verify expanded provider messages, reference labels, branch boundaries and retry
   inputs against the current semantics before removing the flattened storage.
3. Implement the asset/representation design below as a separate schema refactor,
   using binary-specific fixtures before claiming memory or storage savings.

## Asset and representation target

Make `assets` the canonical immutable record of owner, storage key, digest, MIME
type and byte length. Enforce owner-scoped digest uniqueness and resolve a fresh
import operation to existing bytes when appropriate. Filename, caption and placement
remain artifact metadata; equal bytes need not mean equal artifacts. Keep quota
accounting explicit about stored bytes and outstanding reservations.

Add immutable `asset_representations` containing an asset FK, representation kind,
extractor/version, configuration digest, payload digest and payload location.
Original-image representations reference the original bytes; PDF text
representations hold extracted page content once. Extraction job state, retries
and transient errors belong to a separate operational record. Publishing a new
extractor result creates a new representation ID.

Move asset and representation identities out of live/revision JSON into constrained
columns or reference tables. A representation must belong to its referenced asset;
both must belong to the artifact owner. A frozen revision pins the representation
ID, so a later extraction cannot change provider context. Do not create immutable
text payloads on every autosave merely to share a persistence shape.

Replace import `result_json` with a compact receipt recording the created block and
placement identities and any immutable creation facts needed for retry. Replays
must acknowledge that same creation, not create another artifact or overwrite
subsequently moved geometry. Add tests for repeated bytes under different keys,
cross-owner isolation, crash recovery, changed extraction versions, exact frozen
context, backup restoration and quota reconciliation. Only then define safe
reclamation from live content, revisions and pending operations as retention roots.
