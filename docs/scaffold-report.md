# Initial scaffold completion report

This records the first scaffold round. The five recommended tasks below have since been implemented locally; see [follow-up report](follow-up-report.md) for current behavior and verification.

## Repository and documents

The README contains the repository map and local commands. Ten architecture documents were written before application code:

1. `00-principles.md`
2. `01-invariants.md`
3. `02-domain-model.md`
4. `03-snapshot-semantics.md`
5. `04-run-lifecycle.md`
6. `05-client-state.md`
7. `06-collaboration-migration.md`
8. `07-cost-model.md`
9. `08-security.md`
10. `09-non-goals.md`

Deployment documentation includes Caddy, a single-process systemd example, SQLite online backup/restore and R2 configuration.

## Important decisions

The page primitive is **Brane** everywhere: UI actions, domain types, SQL, API and `/b/:braneId` routes. Stable opaque IDs belong to the application. Mutable live content and immutable historical snapshots have separate tables. Geometry belongs only to granular placements. Domain services centralize mutation, snapshots and authorization; React Flow is only an adapter.

Submission atomically resolves versioned edits and ordered context through a snapshot service. RunInput references never change. References and conversation ancestry are distinct structures. Continuation preserves previously included reference material as well as ancestor messages. Manual retry creates a linked Run with the same frozen revisions. Stale running work is interrupted, never automatically paid again.

## Invariants verified

Final validation: **53 tests passed**, TypeScript checking passed, the production build passed, formatting passed, and the built Node server served both `/health` and the browser bundle using a separate temporary SQLite database. The online backup command produced an integrity-checked copy. Browser checks confirmed 374 × 255 placement dimensions persisted across reload, editor focus after drag-create, mobile focus presentation and completed output after navigating away and returning.

Automated tests cover immutable revisions and RunInputs, source editing after submission, atomic edit flush/rollback, coexistence of revisions, domain snapshot-service consumption, placement reuse/removal and geometry isolation, explicit context order, layout independence, branching versus independent-output synthesis, submission deduplication, model/output limits, atomic claiming, stale-lease recovery, traceable retry, cancellation, shutdown interruption, partial/final separation, reconstruction without SSE delivery, centralized ownership and authenticated HTTP enforcement, origin validation, request validation, rate-limit expiry, image signatures, private/reserved destination rejection, DNS pinning, redirect revalidation in the real fetch loop, byte limits and inert text extraction.

Browser verification exercises seed sign-in, brane navigation, drag-create, editor focus, text saves, explicit context, mock runs, source edits with unchanged historical context, exact revision inspection and the responsive mobile focus layout. The development and production builds are checked separately.

## Working and configurable

The local end-to-end path works using a real SQLite database and deterministic mock model: auth → brane → text/placement → persisted edits → frozen run → background worker → SSE/checkpoints → immutable response → reload. Canvas creation, header dragging, resizing, text editing, multi-selection foundation, context composition/reordering, branch continuation, run inspection, retry/cancel, image upload/read, queued webpage imports and manual text fallback are implemented. The worker is independent of navigation.

Real AI SDK/OpenAI invocation and R2 object storage are implemented configuration boundaries; live external-account verification requires credentials. The mock is intentional and identified in the interface. Price estimates, daily dollar budgeting, image vision and optional IndexedDB draft recovery are not implemented. Geometry reuse/removal and explicit snapshots have tested APIs but are not all exposed in the initial UI.

## Intentional differences and limits

- `/b/:braneId` and `/api/branes` replace the specification's page route and endpoint names to honor the requested vocabulary.
- Better Auth uses its conventional `user`, `session`, `account` and `verification` tables instead of a parallel `users` table.
- Ingestion is a small persistent job table with one fetch at a time, not a generic job framework. HTML extraction is deliberately lightweight.
- Image model context is metadata/caption only, explicitly labeled in provider messages. Binary vision is a next slice.
- Confirmed usage is saved when provided; dollar estimates and daily spend remain explicit placeholders. Model allowlist, output/context size and concurrency limits are enforced.
- No multiplayer, CRDT, workflow or distributed infrastructure was added. No public deployment was performed.

## Five recommended next tasks

1. **Durable draft and conflict handling:** add optional IndexedDB recovery keyed by Block ID, restore unsent edits on startup, and provide explicit reload/overwrite choices for version conflicts. Cover offline saves, navigation and tab closure with browser regressions.
2. **Complete asset context:** add an authorized multimodal revision resolver that loads immutable image assets into the AI SDK request, validates supported model capabilities, and displays image inclusion in the frozen-input inspector. Verify the R2 adapter with an isolated bucket.
3. **Provider cost accounting:** verify one real model end to end; add trusted pricing, estimated versus confirmed costs, and an enforced daily reservation/settlement policy that handles uncertain billing and manual retries.
4. **Run recovery observability:** add structured lifecycle logs and operational status, then exercise actual process termination/restart, SSE disconnects, slow consumers and lease expiry against on-disk SQLite in automated integration tests.
5. **Artifact organization polish:** expose placement reuse/removal and explicit snapshots in the UI, improve branch navigation and context previews, and add repeatable browser coverage for drag/resize, keyboard accessibility and mobile focus flows.
