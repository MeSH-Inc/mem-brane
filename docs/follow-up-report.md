# Recommended follow-up implementation

All five recommended work areas have implementation and local verification. Final combined validation: **92 automated tests pass**, TypeScript checking and the production build pass, and the Chromium browser suite passes with zero browser errors. The user explicitly requested **local verification only, with no paid calls**. No live OpenAI account or R2 bucket was used.

## Draft recovery and conflict handling

IndexedDB preserves text, actor/Block identity, base version and save time. Local writes and deletes are ordered; an older asynchronous write cannot recreate a cleared draft. Reload hydrates the authenticated actor's drafts. A remotely changed version remains a conflict until the user chooses server text or explicitly overwrites using the currently displayed version. A second intervening change still fails optimistic concurrency. Pending newer keystrokes retain their text when an earlier HTTP save finishes.

Block text recovery uses IndexedDB. The subsequent [product workflow round](operations/product-workflow-checkpoint.md) adds independent tab-session recovery for composer prompts, model, ordered references, continuation and title drafts across reload/navigation. Closing the tab can discard those workspace drafts. Independent simultaneous drafts of the same Block in multiple tabs are still not separately versioned local artifacts. Browser profile data removal and denied IndexedDB access can prevent recovery; errors are visible and do not block ordinary server saves. This is not CRDT synchronization or automatic merging.

## Image model context

Uploads carry asset ID, MIME type and SHA-256 in content snapshots. Object writes use create-only semantics. Execution authorizes frozen asset IDs, reads bytes through AssetStore, verifies hashes and builds AI SDK multimodal messages using low-detail image input. Changed bytes or missing integrity metadata fail closed. Old images lacking a hash must be re-uploaded before model inclusion. The inspector displays included images and their frozen hash.

The model catalog explicitly declares vision capability and a conservative image-token bound. The local mock accepts this request path but does not claim visual understanding. Local HTTP fixtures exercise the real AI SDK Chat Completions and production Responses protocols, usage extraction, exact image serialization, provider failure without automatic retry, and the R2/S3 adapter's put/get/delete/presigning operations. These fixtures do not replace live-account validation.

## Cost accounting

Run admission atomically freezes context and reserves micro-USD using operator-verified pricing, a conservative text/message/image input bound and maximum output tokens. A preview is an estimate and creates no revisions or runs. Missing pricing or a zero daily budget disables paid admission. Mock runs remain free.

Reserved estimates and pricing are immutable. Valid usage settles at the frozen rates; this is usage-rated cost, not a provider invoice, and can overestimate caching discounts or other price adjustments. Missing usage or uncertain completion retains the reservation across day boundaries. Pre-invocation cancellation and a typed, known preparation failure release it. Provider errors never imply zero billing. Explicit retries reserve separately. If confirmed usage exceeds the configured bound, structured logs identify the discrepancy and later admission sees the full charge.

An operator can reconcile uncertain billing with an integer micro-USD amount and provider evidence; a permanent audit record preserves the decision. The UI exposes preview reservations, remaining budget and run accounting state. Authenticated operations inspection exposes lifecycle, attempts and lease information.

## Recovery and transport verification

An automated subprocess test uses an on-disk WAL database, observes a persisted partial output and heartbeat, sends SIGKILL, starts a fresh worker and verifies interruption without repeated invocation. An explicit retry then completes with unchanged revision IDs. Additional tests verify actor-isolated multiplexed SSE, cancellation of readers, reconnection signals, durable final state without streamed-event delivery, budget reservation/settlement, draft recovery, stale-version detection and object tamper rejection.

Structured lifecycle logs contain Run/worker IDs, status changes, stale leases and budget-bound exceptions, not prompt content or secrets.

## Artifact organization and access

Block actions expose explicit snapshots and their content, placing the same artifact in another brane, removing individual placements while retaining the artifact, and numeric geometry editing for keyboard/touch access. Focus/response navigation and ordered conversation ancestry are available beside the context inspector. Keyboard node moves persist through the geometry domain endpoint; text editing stops canvas keyboard shortcuts.

This work preserves the concurrent canvas-selection and generated-artifact/Spawn changes. Selection identifies placements; explicit model context deduplicates semantic Block IDs. Shared API errors, domain types and cost hooks are coordinated across those changes.

## Recommended next round

1. Follow the bounded interruption/conflict drill in the [product workflow checkpoint](operations/product-workflow-checkpoint.md): exercise concurrent Block edits and interrupted saves, preserve independent Block draft identities if needed, and add a three-way comparison where overwrite decisions lack evidence. Composer/title tab-session recovery is complete.
2. Add an operator budget dashboard for pricing freshness, uncertain liabilities and evidence-backed reconciliation, including cached-token/tier-specific pricing if the chosen provider needs it.
3. Extend the new browser regression suite with offline network transitions, repeated recovery after process shutdown, and interactions between multi-tab drafts and Spawn.
4. Strengthen asset operations with bounded retrieval, explicit retention policies and a restore drill covering SQLite plus object bytes. Keep live-bucket verification optional until authorized.
5. Once authorized, validate one chosen live provider and isolated R2 bucket with a fixed spend cap; compare actual invoices, image token usage and reservation bounds before enabling paid use.

Browser verification in this task created an isolated brane, changed its text in another tab, observed the stale-version conflict, reloaded to recover the same local draft, compared the newer server text and explicitly overwrote it. The temporary verification tabs were closed afterward. Snapshot creation and numeric geometry controls were also checked through the live UI.
