# Domain model independent of SQL

User authenticates an actor. Brane has stable identity, current title and owner; centralized access policy can later resolve memberships/roles. Brane contains Placements, not conversations.

Placement references one Block and contains mutable brane-specific x/y/width/height/z-order. A Block may appear twice in one brane or in several branes. Block holds identity, content kind, origin (authored or generated), and creator. LiveBlockState holds mutable content and a version for optimistic edit protection; this version is not a vector clock.

BlockRevision holds immutable content, block identity and creation time. One revision may be referenced by many runs. Snapshotting never includes geometry or presence.

Content kinds: text, image (asset reference and caption metadata), and webpage (URL, ingestion status and imported text managed by server, manual fallback supported). Authored text and webpage content have editable LiveState. Generated content has no editable LiveState; an active RunCheckpoint becomes a finalized revision. Spawn produces generated text from ordered frozen source revisions. Derivation links are projected from RunInput and the run output; disposable placement anchors control canvas presentation. See 10-artifact-derivation.md.

Conversation groups message branches. ConversationMessage has immutable parent pointer, role, revision and conversation ID. Continue reconstructs one ancestor chain through a selected point. References from independent branches retain labels and order without becoming ancestors.

Run has immutable submission identity, frozen inputs, provider/model/options, continuation point and optional retry-of ID. Lifecycle, lease, error, usage and finish time are operational mutable fields. RunInput is immutable and ordered, distinguishing reference, lineage and prompt roles. RunOutput binds final immutable revision to Run. RunCheckpoint is mutable partial text, replaced in batches. RunAttempt records invocation boundary, heartbeat and outcome; a manual retry is a separate Run with a new attempt.

Asset stores metadata, owner and opaque storage key; bytes live in an AssetStore. Asset access is authorized independently of storage URLs. No domain type depends on Hono, React Flow or better-sqlite3.
