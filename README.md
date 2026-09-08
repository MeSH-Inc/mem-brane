# mem-brane

A spatial thinking interface. Open a **brane**, drag on empty space to create a thought, add selected artifacts as explicit context, and run an exploration. **New brane** and **Save brane** are the product language; the domain type is `Brane`, SQL uses `branes`, and routes use `/b/:braneId`.

## Run locally

Requires Node.js 22.13+ (tested with Node 24), npm, and a platform supported by better-sqlite3. If a native prebuild is unavailable, install your platform's C/C++ build tools.

```sh
npm ci
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

Open [localhost:5173](http://localhost:5173). The development seed creates `hello@mem-brane.local` with password `mem-brane-local-only`. Set `SEED_EMAIL` and `SEED_PASSWORD` to override, or create an account through the interface. Never seed production. Use `localhost`, matching `APP_ORIGIN`; if you prefer `127.0.0.1`, change `APP_ORIGIN` accordingly.

The default model is **mock**: deterministic streaming, no provider credentials, and no model spend. To enable real invocation, configure `OPENAI_API_KEY`, add an OpenAI model ID to `MODEL_ALLOWLIST` alongside `mock`, and optionally change `MODEL_DEFAULT`. Limits are enforced on the server. Paid runs require a positive `DAILY_USER_SPEND_LIMIT` and operator-verified `MODEL_PRICING_JSON`; admission reserves a conservative usage bound atomically. A zero budget disables paid runs.

```sh
npm run dev:web       # Vite only
npm run dev:server    # Hono + background workers only
npm test             # invariant, security and authenticated API tests
npm run typecheck
npm run format:check
npm run build        # browser bundle and Node server
npm start            # serves dist + API from port 3001
```

## Stack and structure

React, TypeScript, Vite, React Flow, Zustand and TanStack Router in the browser. Hono on Node, Better Auth, better-sqlite3 in WAL mode, AI SDK Core, authenticated SSE, and filesystem or R2/S3-compatible image storage on the server. One process owns SQLite-backed background work. No Redis or distributed worker infrastructure.

```text
docs/architecture/   principles, invariants and migration boundaries
src/app/            authentication, navigation, styles
src/routes/         brane workspace, focus view, context inspector
src/canvas/         React Flow rendering and gesture adapter
src/components/     content editors and renderers
src/stores/         transient Zustand interaction state
src/services/       HTTP domain API client
src/lib/            responsive presentation helpers
server/app/         configuration and process lifecycle
server/api/         validated domain endpoints and rate-limit hook
server/auth/        Better Auth SQLite integration
server/db/          WAL connection and migration runner
server/domain/      centralized authorization and domain errors
server/services/    content, snapshots, placements, context and runs
server/jobs/        atomic claiming, leases, checkpoints, finalization
server/llm/         frozen-message assembly, mock and AI SDK invocation
server/sse/         actor-scoped multiplexed update hub
server/storage/     filesystem and R2/S3 adapters
server/ingestion/   queued, bounded, DNS-pinned webpage imports
shared/types/       framework-independent product types
shared/schemas/     request validation
migrations/         relational schema and immutable history guards
scripts/            migrate, seed and consistent SQLite backup
tests/              domain invariants, security and authenticated HTTP
```

## Product model

A Block has stable semantic identity. Its current editable LiveState is separate from immutable BlockRevisions. A Placement puts the Block on a brane with independent geometry. One Block can have several placements, including across branes; removing a placement leaves the artifact intact.

A Run freezes an explicit ordered list of revisions at submission. Pending edits can be flushed inside the submission transaction using expected versions. Later edits cannot change the recorded context. Workers assemble provider messages exclusively from frozen inputs. Historical requests are reconstructable; model output itself is not guaranteed deterministic.

The following diagram is conceptual, not a strict relational direction graph:

```text
                 ┌──────────────────┐
                 │    LiveState     │
                 │ mutable/current  │
                 └────────┬─────────┘
                          │ snapshot
                          ▼
                 ┌──────────────────┐
                 │     Revision     │
                 │    immutable     │
                 └────────┬─────────┘
                          │
                          ▼
┌───────────┐    ┌──────────────────┐
│ Placement │───▶│      Block       │
│ geometry  │    │ stable identity  │
└───────────┘    └──────────────────┘

Revision(s)
    │
    ▼
┌──────────────────┐
│       Run        │
│ frozen context   │
└────────┬─────────┘
         │
         ▼
 output Revision
```

**Use as context** imports labeled references in user-controlled order. **Continue from here** follows one conversation's ancestor chain, including the reference material used at those points. Combining independent responses as references never invents a shared conversation history. Canvas proximity, selection, dragging and resizing do not submit models or alter context.

React Flow nodes are projections of domain records. Zustand holds selection, drafts, tools and context composition; neither owns the persistent document. Geometry persists after completed gestures. Text saves are debounced and version-checked. Save brane flushes edits and saves the title. Explicit snapshots are available through the domain/API, independently of geometric saves.

## Background execution

Submission deduplicates per-user request keys before creating paid work. One SQLite worker atomically claims queued runs, leases and heartbeats them, and invokes the provider outside transactions. Streamed text is checkpointed in batches. Only completion creates an immutable response revision. An explicit retry creates a new Run linked to the old one and copies exact frozen inputs.

Navigation never cancels a Run. One authenticated browser SSE stream multiplexes updates; a reconnect reloads authoritative state. Final output survives lost events. Expired claims are requeued only before invocation; expired running work becomes interrupted, with uncertain provider completion/billing, and is never automatically retried. Shutdown aborts active calls best-effort and records interruption.

## Interaction

Desktop: drag empty space to create a rectangle; its editor receives focus. The header moves the card. Select a card to resize it. Shift-click supports multiple selection. Choose Pan or use the middle mouse button to navigate. Use Fit View to find offscreen cards. Text selection does not move nodes.

Mobile defaults to Focus: full-width editor, horizontal block outline, tap-to-add, ordinary text paste, image picker and brane navigation. Canvas is an optional overview. `/b/:braneId?focus=:blockId&view=focus` opens a focused block; viewport changes do not add history entries.

## Boundaries and limitations

- Real OpenAI invocation and R2 adapters are implemented but require your credentials and have not been exercised against live accounts. Mock execution and local storage need none.
- Image context resolves authorized bytes from frozen asset IDs and SHA-256 hashes. Models must explicitly support vision in the pricing catalog; requests use low detail. The mock accepts images but does not perform visual reasoning.
- Webpage extraction is lightweight text extraction, without a browser or rich readability parser. Failed imports permit manually pasted text. HTTP(S) destinations and redirects are validated, DNS is pinned, and time/byte bounds apply.
- Budget reservations, usage-rated costs and uncertain liabilities are persistent and separate. Usage-rated amounts use the configured token rates; they are not provider invoices and may overestimate cached-input discounts. Interrupted or unmetered requests retain their reservations until explicit, audited reconciliation.
- IndexedDB preserves text drafts with their original server version, scoped by actor and Block ID. Reload offers recovery; a conflict offers server text versus explicit overwrite. This is local recovery, not collaboration or an automatic merge. Browser storage failure is visible and server saves remain possible.
- Block actions expose snapshots, reuse across branes, granular placement removal and numeric geometry controls. The context inspector shows conversation ancestry, images and run billing state.
- Public signup is enabled; before exposing a personal VPS, decide whether to disable signup after your first account or add an invitation policy. Email delivery, verification and password recovery are outside this slice.

## Architecture and operations

Read [architecture principles](docs/architecture/00-principles.md), [invariants](docs/architecture/01-invariants.md), and [deployment notes](docs/deployment.md). The ten numbered architecture documents cover domain modeling, snapshots, run lifecycle, client state, collaboration migration, cost, security and non-goals. [Scaffold report](docs/scaffold-report.md) records verification and next work.

Multiplayer, CRDTs, presence, WebSockets, workflow execution, rich text, embeddings, semantic retrieval, plugins, headless crawling, multi-server workers and multi-region infrastructure are deferred. Future collaboration replaces LiveState persistence behind domain mutations and snapshot materialization. Product IDs, immutable revisions, placement semantics and frozen Run context remain intact; presence stays ephemeral.

See [follow-up implementation notes](docs/follow-up-report.md) for local adapter tests, draft recovery, budget semantics and the remaining operational limits.
