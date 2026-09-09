# Client state

Server-authoritative: branes, blocks, persisted LiveState, revisions, placements, runs, finalized outputs and assets. Fetch these through domain APIs and reload on SSE reconnect.

Zustand owns transient placement selection (a canonical set, allowing multi-selection), local edit drafts, active tool and inspector. An actor/brane-scoped `WorkspaceController` owns workspace operations and the sole authoritative composer context; context is not mirrored into Zustand. Focus/view belongs to the router; the draft rectangle and in-progress placement geometry belong to the mounted canvas. React Flow nodes are projections of domain records plus transient interaction state, never serialized as canonical canvas data. Textareas stop canvas gestures; a header grip drags. Debounced text changes use optimistic versions. Run and Save brane await required saves; domain submission also accepts versioned edits for atomic flushing.

Viewport updates do not add browser history. TanStack Router handles /b/:braneId and focus/view search values. Mobile defaults to focus mode and uses add buttons, paste, file input and a block outline. A stream stays mounted above brane routes so navigation cannot own worker lifetime.

Text draft recovery uses IndexedDB, scoped by authenticated actor and Block ID. Each draft retains its original server version. Hydration never silently rebases onto newer text; conflicts require a visible choice. Writes/deletes are serialized so clearing a saved draft cannot be undone by an older pending write. Browser storage is optional to successful server saving and its failure is visible.

Selection has one owner: Zustand. React Flow selection changes are explicit commands through `onNodesChange`; node selection is derived during render. Never mirror selection back from `onSelectionChange`, or copy projected nodes into state in an effect. Equivalent selection sets preserve the store snapshot. Removing placements prunes unavailable placements; switching views retains selection. Placements are selected independently, including duplicate placements of one block. The route derives unique Block IDs for context commands. Canvas and route subscribe to the fields they use.

The canvas owns only in-progress gesture geometry. Content and streamed run updates continue rendering during drag/resize without replacing that geometry. Final position (including keyboard movement) and resize changes enqueue one geometry intent per placement. The controller projects pending intents over saved placements. Measurement notifications do not persist geometry. React Flow callbacks and projection inputs are stable between relevant changes.

Validation: `npm run test:browser` runs Chromium against real BraneView, routing and canvas components with fixture APIs, covering view switching, multi-selection, streaming during resize and keyboard persistence. Run `npx playwright install chromium` once when setting up a new machine. The jsdom canvas suite exercises external selection, remounts, duplicate placements, removal, idempotence and gesture completion under StrictMode.

Canvas tools are explicit: Write creates a thought from an empty-pane drag, Pan moves the viewport (including header drags), and Select draws an intersecting marquee. `tools.ts` defines the library-independent tool catalog and type. `toolPolicy.ts` maps those tools to React Flow gesture settings and help text. Shift-click toggles placements, while marquee selection replaces the set. Middle/right mouse panning remains available; touch retains viewport panning. Pan disables node movement, selection and resize handles; editors and actions retain their own pointer behavior. Mobile hides the canvas-tool group by class rather than toolbar position.

`useCanvasGesture` owns the lifetime of empty-pane pointer gestures and Write's rectangle. React Flow owns marquee rendering and hit testing. Escape, tool changes, blur, pointer cancellation, lost capture and unmount abort unfinished gestures. An aborted marquee restores its initial placement selection; an aborted Write gesture never creates a block. A cancelled marquee remounts the React Flow gesture owner with the retained viewport to clear both its private gesture refs and rectangle, without using its internal store API. Completed gestures retain their normal controlled-state path. Browser tests cover partial overlap, zoom, duplicate placements/context resolution, reverse multi-card marquee, empty clicks, group movement, editor isolation, middle-button pan and cancellation/restart. Cancellation events that automation cannot generate through mouse input are explicitly injected after real pointer drags.

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
new workspace. Local drafts and request journals survive disposal. Geometry writes
already enqueued drain in their existing queue; geometry remains an in-memory intent
with the existing unload warning rather than a reload-durable document.

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
