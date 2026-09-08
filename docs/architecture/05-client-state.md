# Client state

Server-authoritative: branes, blocks, persisted LiveState, revisions, placements, runs, finalized outputs and assets. Fetch these through domain APIs and reload on SSE reconnect.

Zustand owns transient placement selection (a canonical set, allowing multi-selection), local edit drafts, active tool and inspector. Focus/view belongs to the router; the draft rectangle and in-progress placement geometry belong to the mounted canvas. React Flow nodes are projections of domain records plus transient interaction state, never serialized as canonical canvas data. Textareas stop canvas gestures; a header grip drags. Debounced text changes use optimistic versions. Run and Save brane await required saves; domain submission also accepts versioned edits for atomic flushing.

Viewport updates do not add browser history. TanStack Router handles /b/:braneId and focus/view search values. Mobile defaults to focus mode and uses add buttons, paste, file input and a block outline. A stream stays mounted above brane routes so navigation cannot own worker lifetime.

Text draft recovery uses IndexedDB, scoped by authenticated actor and Block ID. Each draft retains its original server version. Hydration never silently rebases onto newer text; conflicts require a visible choice. Writes/deletes are serialized so clearing a saved draft cannot be undone by an older pending write. Browser storage is optional to successful server saving and its failure is visible.

Selection has one owner: Zustand. React Flow selection changes are explicit commands through `onNodesChange`; node selection is derived during render. Never mirror selection back from `onSelectionChange`, or copy projected nodes into state in an effect. Equivalent selection sets preserve the store snapshot. Removing placements prunes unavailable placements; switching views retains selection. Placements are selected independently, including duplicate placements of one block. The route derives unique Block IDs for context commands. Canvas and route subscribe to the fields they use.

Only active gesture geometry overlays server placements. Content and streamed run updates continue rendering during drag/resize without replacing that geometry. Final position (including keyboard movement) and resize changes call the route's optimistic geometry action once per placement; the route owns persistence and rollback. Measurement notifications do not persist geometry. React Flow callbacks and projection inputs are stable between relevant changes.

Validation: `npm run test:browser` runs Chromium against real BraneView, routing and canvas components with fixture APIs, covering view switching, multi-selection, streaming during resize and keyboard persistence. Run `npx playwright install chromium` once when setting up a new machine. The jsdom canvas suite exercises external selection, remounts, duplicate placements, removal, idempotence and gesture completion under StrictMode.
