# Client state

Server-authoritative: branes, blocks, persisted LiveState, revisions, placements, runs, finalized outputs and assets. Fetch these through domain APIs and reload on SSE reconnect.

Zustand owns transient placement selection (a canonical set, allowing multi-selection), local edit drafts, active tool and inspector. An actor/brane-scoped `WorkspaceController` owns workspace operations and the sole authoritative composer context; context is not mirrored into Zustand. Focus/view belongs to the router; the draft rectangle and in-progress placement geometry belong to the mounted canvas. React Flow nodes are projections of domain records plus transient interaction state, never serialized as canonical canvas data. Textareas stop canvas gestures; a header grip drags. Debounced text changes use optimistic versions. Run and Save brane await required saves; domain submission also accepts versioned edits for atomic flushing.

Viewport updates do not add browser history. TanStack Router handles /b/:braneId and focus/view search values. Mobile defaults to focus mode and uses add buttons, paste, file input and a block outline. A stream stays mounted above brane routes so navigation cannot own worker lifetime.

Text draft recovery uses IndexedDB, scoped by authenticated actor and Block ID. Each draft retains its original server version. Hydration never silently rebases onto newer text; conflicts require a visible choice. Writes/deletes are serialized so clearing a saved draft cannot be undone by an older pending write. Browser storage is optional to successful server saving and its failure is visible.

Selection belongs to the application, scoped to placement identities. Equivalent
selection sets preserve the store snapshot; removing a placement prunes it. Context
commands resolve selected placements to unique blocks. Editors, rendered content,
links and command controls own their native browser gestures in every tool and do
not change placement selection as a side effect.

`CanvasGestures` owns recognition, preview, commit and cancellation. All canvas
surfaces use an eight-screen-pixel click tolerance. Select is the default: a header
click selects, Shift-click toggles, empty clicks clear, and empty drags marquee.
Write clicks create a default-size thought; drags choose its rectangle. Pan and
middle/right mouse drags move the viewport. Touch pans and pinches the overview.
Wheel gestures pan, with Control/Command-wheel zooming around the pointer.

Drag/resize previews retain their starting geometry through incoming content
updates. Completion commits each changed placement once. Escape, tool changes,
blur, pointer cancellation, capture loss and unmount abort without persistence and
restore the starting selection. Cancellation never remounts the canvas. Keyboard
arrows move selected placements by 5 units, or 20 with Shift, outside native editors.

React Flow is a rendering and viewport adapter. Its selection, drag, resize,
keyboard, wheel and pointer zoom handlers are disabled. Card pointer targeting is
explicit even in Pan. Application resize handles and `useCanvasGesture` translate
browser input into the gesture owner. Node geometry, selection and provenance
edges remain projections of domain records; library measurement cannot persist
geometry. Pure state-machine and Chromium tests exercise this interaction contract,
including jitter, native controls, cancellation and updates during resizing.

Placement geometry uses optimistic concurrency. Each placement has a monotonically increasing `version`; PATCH requires that version and atomically returns the updated placement or HTTP 409. GET placement applies the same ownership checks. Migration 005 initializes existing placement versions to zero.

`PlacementSaves` owns one independent write lane per placement. It sends at most one request per lane, coalesces waiting moves into the newest intent, and advances the next expected version only from that lane's successful acknowledgement. Refreshes cannot silently rebase queued edits onto another writer's version, and older snapshots cannot replace newer acknowledged geometry. The controller also ignores fetch responses and failures superseded by a newer refresh request. The numeric geometry form uses the same queue as drag, resize and keyboard movement.

Failures pause the affected lane without rolling back the latest local geometry. “Save my latest placement” explicitly reads the current version before retrying; “Use saved placement” reads authoritative geometry before discarding the local intent. A delayed discard does not clear a newer move. Other placements continue saving independently. Confirmed placement removal cancels pending work for that placement. Save brane awaits the geometry queue; pending geometry contributes to the unsaved indicator and unload protection. Pending geometry is kept in memory, unlike IndexedDB text draft recovery.

Geometry tests use deferred promises to exercise acknowledgement ordering, remote-version conflicts, coalescing, independent lanes, failed reads, explicit retry/discard and stale refreshes. Browser coverage holds actual PATCH responses while newer keyboard moves are made and verifies the conflict/retry UI. API tests enforce version preconditions and ownership for both reads and writes.

The route loads `BraneCanvas` through a lazy import only when Canvas is rendered. React Flow and its stylesheet remain behind that boundary; Focus and the toolbar depend only on the library-independent tool catalog. A local Suspense fallback keeps navigation and the composer available while the canvas loads. Browser tests cover explicit Focus and the mobile default, delayed loading, returning to Focus during loading, and subsequent canvas activation.

Text acknowledgements and workspace refreshes pass through `TextSaves`, which accepts
only increasing authored block versions. The same service serializes text writes and
Spawn snapshots. A delayed read cannot erase an acknowledged save.

Composed submissions distinguish preparation, delivery, definite rejection and
uncertain delivery. Definite rejection permits corrected inputs with a new key.
Uncertain delivery retries the exact frozen request and key without flushing new edits.
Accepting an older request preserves a different current composer prompt. API calls
have a thirty-second deadline; expired sessions return to authentication while local
text draft recovery remains available.

## Workspace command ownership

`src/services/workspace.ts` exposes observable state and explicit commands for text
and placement saves, draft recovery, Run/Spawn submission, imports, and inspection.
Its dependencies are the HTTP transport, browser-tab storage, actor draft store,
import service, and event target. It can be exercised without React or the router.
`BraneView` subscribes through `useSyncExternalStore`, renders state, and translates
successful create/spawn results into presentation navigation. Canvas receives
context/continuation commands through props; it owns selection and gestures only.

Construction performs no subscriptions or network requests. `start` acquires event
subscriptions and polling, loads authoritative state and model configuration, and
starts import delivery. `dispose` removes subscriptions, cancels debounce/polling
timers, and invalidates outstanding callbacks. Requests already sent may still
commit: their old controller cannot clear another actor's draft or navigate the
new workspace. Local drafts and request journals survive disposal. Completed geometry writes join the account-scoped IndexedDB replica and durable
outbox before transmission. In-progress gestures remain transient; a failed local
transaction preserves the in-memory intent and unload warning.

Refresh, lineage, estimate and inspection results are ordered independently. Older
workspace reads cannot erase acknowledged edits or stream progress received while
the read was in flight. Context changes invalidate old lineage/estimate responses.
Composer prompt, title, model, ordered references and continuation have one owner in
`WorkspaceDrafts`, persisted per actor/brane within the tab.

## One submission protocol

Run and Spawn share `Submission`, with one journal lane for composed runs and one
per Spawn source. The journal persists the exact transport payload and local draft
identities before sending. Local identities stay in browser storage and are not
sent to the server. Uncertain retries reuse both, including across navigation or
reload; choosing a different recovered draft never authorizes rebasing it from an
older request's receipt. Definite rejection retires the journal entry and allows
corrected intent with a fresh request key.

Both commands join the text write queue for preparation, transport and acknowledgement.
Run sends versioned edits for its explicit editable references in the same request
that freezes context; it does not flush unrelated workspace drafts first. Unchanged
editable sources also carry version preconditions, closing the window where a
second writer could silently replace a source after autosave. Spawn applies the
same rule to its source set. Generated sources and immutable conversation lineage
are resolved through their existing revision boundaries.

Both HTTP submission endpoints return `{ runId, outputBlockId, edits }`. Each edit
receipt contains its block ID, actual accepted version and content. Migration 021
adds immutable `submission_receipts`, written inside the admission transaction.
Deduplicated submission returns that original receipt, even after subsequent edits
or worker completion. A no-op edit retains its version. The client validates the
receipt before retiring the journal, reconciles acknowledged versions monotonically,
and preserves newer typing and separately recovered copies. Ordinary failed-run
retry remains a new execution of frozen context, distinct from delivery retry.

Headless workspace tests cover save/navigation/disposal, actor switching, recovery,
refresh and stream ordering, stale lineage/estimate responses, import delivery,
atomic submission payloads, no-op versions, and exact journal replay. Server tests
verify durable receipts, immutable storage, ownership and transaction rollback;
browser tests cover the integrated UI and reload recovery.

## Offline workspace replica

`WorkspaceReplica` is the foreground client's persistence boundary for ordinary
workspace mutations. Its IndexedDB transaction commits a projected workspace and
an ordered operation together. The controller's write acknowledgements mean local
persistence; the application status separately reports pending synchronization.
Text, placements, brane creation and title changes use this path both online and
offline. Existing editor drafts protect changes before local commit; Run/Spawn
journals continue to protect uncertain paid submissions.

Server operation receipts are atomic with mutations and keyed by account plus
operation UUID. The request hash prevents key reuse with different content.
Creation uses client-generated UUIDs, removing temporary-ID remapping from dependent
offline edits. Text and geometry carry expected versions; deletion is versioned
and title updates compare their previous value. A blocked head pauses replay.
Explicit conflict resolution rebases or drops the affected item's queued changes
and rebuilds the projection from authoritative state, retaining unrelated intents.
Controller acknowledgement caches reset after that deliberate version change.

The replica caches opened workspaces, immutable page/revision reads and previously
requested detail responses. Originals are stored as account-scoped blobs; UI object
URLs are revoked on unmount. The service worker owns only versioned public shell
assets. Web Locks serialize replay and resolution within the browser, IndexedDB
serializes concurrent local transactions, and BroadcastChannel announces changes.
Network snapshots cannot overwrite writes committed during their fetch. Expected
actor headers bind requests to the session even if another tab switches accounts.
See [offline behavior](../offline-pwa.md) for supported operations and limitations.

## Presentation and attention

An actor/brane-scoped presentation store retains viewport, focused block and
placement selection across view changes and navigation. Camera/focus recovery uses
session storage independently of document durability. Pointer, keyboard and wheel
input advances an attention epoch. Create and Spawn capture that epoch; a delayed
completion may request focus or framing only while it still matches. Editor focus
and canvas reveal requests are consumed once, so remounting cannot replay them.
Desktop Focus opens newly created thoughts just as mobile Focus does. React Flow
reports viewport changes into this presentation store; its initial viewport comes
from that store on remount.

## Reactive document projection

`WorkspaceDocument` owns the observable workspace projection and normalized block,
run and command-activity indexes. Equivalent server refreshes preserve entity
identity. Scene geometry and provenance have their own stable snapshot, independent
of content, streams, composer changes and command activity. Placement-save intents
project through this same store. The controller reads this projection directly;
it no longer reconstructs placements each time React reads its state.

Canvas is memoized and subscribes to the scene. Its cached node projections retain
unchanged node identities. Cards subscribe to their block, run status and command
activity; `LiveBlockContent` subscribes to one block and its partial output. Stream
chunks update the document without notifying the entire workspace controller.
The same content component serves Focus. A React Profiler regression verifies that
streaming one block causes no render commit in an unrelated editor.
