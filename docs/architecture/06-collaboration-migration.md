# Collaboration migration (deferred)

React UI → Domain services → LiveDocument boundary → future CRDT implementation.

The present boundary is concrete mutation/snapshot functions over ordinary rows. Do not add Yjs now. Do not add Automerge now. Do not create fake CRDT operations or complicated vector clocks/version abstractions.

Potential collaboration units: text Block LiveState, Placement geometry, brane membership and possibly ordered context composition. Product identities remain stable. Revisions remain immutable materializations and runs keep frozen references. CRDT storage IDs are infrastructure metadata, never Block or Placement IDs.

Later HTTP can retain ordinary operations, WebSocket or equivalent can carry CRDT sync and ephemeral presence, SSE can retain model events, Postgres can replace metadata/snapshot storage if needed, and object storage can retain binary assets. CRDT persistence is separate live-document infrastructure. These are directions, not commitments.

Cursor, selection, currently editing, viewport and user display metadata are ephemeral presence, not ordinary persisted content and never revision content. Add brane memberships and roles behind existing access policy before sharing. No multi-server workers are claimed today.
