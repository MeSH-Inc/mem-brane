# Read projections and revision history

Workspace reads return the explicit `BraneState` contract: brane metadata,
placements, unique placed blocks, run summaries and visible derivations. SQL
ownership, request hashes, lease fields and serialized options are not workspace
fields. Content is returned once per block even when multiple placements use it.
Generated content is resolved through its run output, not a timestamp-based search
over revisions. A unique index enforces one producing run per output block.

Completed run summaries contain an empty `partial`; their content belongs to the
final block revision. Failed and active checkpoints remain available in summaries.
This projection does not delete checkpoint evidence. Workspace reads include full
block content, runs producing placed blocks (including outputs reused from another
brane), and active runs originating in the brane. They do not include removed,
stopped history and are not a lazy content-loading protocol.

Visible run and derivation queries start from distinct placed Block IDs with a
fixed outer join loop and indexed producer lookup. Active runs use a partial index.
Their query work therefore does not depend on removed output history. SSE updates
also match visible Run IDs so an output reused from another brane keeps streaming.

`GET /branes/:id/runs` returns `{ items, nextCursor }` in descending
`(created_at, id)` order, with 25 items by default and a maximum of 50. Run history
contains explicit summaries without checkpoints and is fetched when the user opens
Run history. Refresh restarts pagination; older pages retain the immutable creation
cursor. Authorization and cursor membership are checked against the brane.

`GET /blocks/:id/revisions` returns `{ items, nextCursor }`, with 25 revisions by
default and a maximum `limit` of 50. Send `cursor=nextCursor` to request older
revisions. The cursor identifies an immutable revision of the same block; ordering
uses descending `(created_at, id)` so equal timestamps cannot skip records. Newer
insertions do not shift subsequent pages. A composite index supports the ordering.
The UI appends pages on explicit request and discards superseded responses.

History items, individual revision reads and snapshots share the `Revision` shape.
They contain parsed `content` without a duplicate `content_json` field. Frozen run
inputs similarly expose only their declared fields and parsed content.
