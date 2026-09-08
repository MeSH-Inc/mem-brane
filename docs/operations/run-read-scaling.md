# Run-read scaling — September 8, 2026

Workspace run retrieval and derivation lookup now depend on visible outputs and
active runs. Run history uses a separate keyset-paginated API and is loaded on
demand. The fixture compares 80 versus 2,580 completed, removed outputs with the
same two visible blocks, two active runs (one unplaced), and one visible derivation.

| Query                   | 80 removed outputs | 2,580 removed outputs |
| ----------------------- | -----------------: | --------------------: |
| Placed blocks           |       159 VM steps |          159 VM steps |
| Visible and active runs |       168 VM steps |          168 VM steps |
| Visible derivations     |        93 VM steps |           93 VM steps |
| First run-history page  |       398 VM steps |          398 VM steps |

The [raw report](read-scaling.json) records SQL captured from actual service calls,
query plans from the application's SQLite library, and execution steps from the
system SQLite CLI. Both engine versions are recorded; CLI steps are a complexity
probe, not an application latency measurement. VM counts exclude internal B-tree
traversal; indexed lookup costs may still grow with index depth. The script fails if any measured
query grows by more than 25 steps between fixtures. It uses real domain submission
and deterministic worker finalization, never a paid provider or live database.

```sh
NODE_ENV=test node --import tsx scripts/read-scaling.ts /tmp/read-scaling.json
```

Set `SQLITE_CLI` to a CLI supporting `.stats vmstep` if needed. On macOS the default
is `/usr/bin/sqlite3`; other hosts use `sqlite3` from PATH. Full visible text still
belongs to the workspace response. This change bounds history-related read work;
it does not reduce text transfer for a densely populated brane.

The [post-normalization report](read-scaling-contexts.json) repeats the same probe
after introducing context manifests. Visible/active reads remain at 168 VM steps,
derivations at 92, and the first history page at 398 in both fixture sizes.
