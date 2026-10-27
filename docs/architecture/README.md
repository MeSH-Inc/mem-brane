# Architecture overview

## Domain and persistence

| Record        | Responsibility                                                         |
| ------------- | ---------------------------------------------------------------------- |
| Block         | Stable artifact identity, content kind and authored/generated origin   |
| LiveState     | Current editable content for authored blocks, with version checks      |
| BlockRevision | Immutable snapshot used by history and model inputs                    |
| Placement     | One block instance on one brane, with independent geometry and version |
| Run           | Execution state and an ordered set of frozen input revisions           |

A block can have several placements, including across branes. Removing a placement leaves the block intact. Generated artifacts have no editable live state; streamed checkpoints become an immutable output revision only after successful completion.

Run and Spawn capture prompt, sources and source text synchronously at activation. They reserve only the affected text lanes, so later typing cannot change a queued request and unrelated edits continue. On the server, they apply pending source edits in that same transaction using expected versions. Their durable receipts return the actual accepted edit versions, including unchanged versions for no-op edits. Workers assemble provider messages from those frozen inputs, so later edits and layout changes cannot alter the recorded request. Requests are reconstructable; real model output is not guaranteed deterministic.

Spawn's **Develop** action answers explicit requests or expands an idea into a self-contained artifact. The current UI spawns from one source; the service supports ordered multiple sources. Derivation connectors project provenance from run inputs and outputs. They do not define a workflow or trigger downstream regeneration.

React Flow nodes project domain records. Zustand owns transient selection, tools and text drafts. An actor/brane-scoped workspace controller owns saving, recovery, imports, streamed updates and the authoritative composer context. The application owns gesture recognition and cancellation; React Flow renders the result. A per-brane presentation store retains camera, selection and focus. Delayed actions reveal results only while the user’s attention is still on the action. The canvas owns in-progress gesture geometry; a per-placement save queue serializes completed moves and coalesces waiting updates. Version conflicts preserve the newest local geometry and offer explicit retry or use-saved-placement actions. Delayed responses and older refreshes cannot overwrite newer acknowledged geometry.

Text autosave uses version checks. IndexedDB retains recoverable drafts with their original server version, scoped by actor and block. Text conflict recovery offers server text or explicit overwrite. Completed placement intents and ordinary workspace mutations commit to an account-scoped IndexedDB replica and outbox before synchronization. Replica replay follows entity dependencies instead of an account-wide queue. Cancellation bypasses local writes and conflicts, and new server output can refresh around pending edits. Opened workspaces support offline reload and editing; reconnect conflicts require an explicit choice. This is not automatic merging or multiplayer collaboration. See [offline PWA behavior](../offline-pwa.md).

## Background work

One server process runs SQLite-backed generation and webpage-import workers. Generation submission deduplicates per-user request keys, and workers claim queued runs atomically, maintain leases and checkpoint streamed text. Provider calls run outside database transactions.

One authenticated browser SSE connection multiplexes updates. Reconnection reloads authoritative state, so final results survive missed events. Navigation does not cancel work. Explicit retry creates a new run from the original frozen inputs. Retrying an uncertain Run or Spawn submission reuses its journaled request and key across navigation and reload; that is separate from retrying a failed generation.

Expired claims can be requeued before invocation. Expired running work becomes interrupted and is never automatically retried because provider completion and billing may be uncertain. Shutdown aborts active calls best-effort and records interruption. Run exactly one server/worker process; this is not a distributed worker system.

## API errors

Every refusal has the body `{error, code, retryable}` defined in `shared/errors.ts`. The `code` names what the user can do next (`guest_limit`, `budget`, `quota`, `capacity`, `rate_limited`, and the HTTP-shaped codes), and `retryable` says whether the same request may later succeed unchanged. Unexpected failures add a `requestId` that is also written to the server log. The offline replica pauses an operation for review only when its refusal is not retryable; a rate limit or full queue keeps it queued.

## Stack and repository map

The browser uses React, TypeScript, Vite, React Flow, Zustand and TanStack Router. The server uses Hono, Better Auth, SQLite in WAL mode, AI SDK Core, authenticated SSE, and filesystem or S3-compatible image storage. Redis is not required.

```text
src/app/            authentication, navigation and styles
src/routes/         workspace, Focus view and context inspector
src/canvas/         node projection, tool policy and gesture lifetime
src/components/     editors, artifact actions and rendering
src/stores/         transient interaction state
src/services/       workspace controller, submission journals and save/recovery services
src/lib/            responsive presentation helpers
server/app/         configuration and process lifecycle
server/api/         validated endpoints and request limits
server/auth/        authentication integration
server/db/          WAL connection, migrations and typed record decoders
server/domain/      authorization and domain errors
server/services/    artifacts, snapshots, placements, context, costs and runs
server/jobs/        claiming, leases, checkpoints and finalization
server/llm/         frozen-message assembly and provider invocation
server/sse/         actor-scoped update hub
server/storage/     filesystem/S3 adapters, backups and restore verification
server/ingestion/   bounded, DNS-pinned webpage imports and image/PDF extraction
shared/             domain types, command schemas and public response contracts
migrations/         baseline schema, later changes and immutable-history guards
scripts/            migration, seed, backup, restore, measurement and device tests
tests/              unit, API, recovery and invariant tests
e2e/                browser fixtures and interaction tests
docs/architecture/  design boundaries and invariants
```

## Current boundaries

- Webpage imports use lightweight text extraction, without browser rendering or a rich readability parser. HTTP(S) targets and redirects are validated, DNS is pinned, and time/byte limits apply. Failed imports permit pasted text.
- Image context resolves authorized bytes using frozen asset IDs and SHA-256 hashes. Paid models must explicitly support vision in the pricing catalog; image requests use low detail.
- Signup can be open, invitation-only or closed. Guest workspaces support account claiming; after guest expiry and a seven-day recovery grace, unclaimed content is reclaimed with durable asset deletion. Email delivery, password recovery and backup alerts are implemented but require operator configuration and delivery acceptance; email verification is not implemented. See [recovery and alert activation](../operations/recovery-and-alerts.md) and [retention](../operations/retention.md).
- Local tests cover mock execution, adapter fixtures, authenticated APIs, migrations, worker crash recovery and browser interactions. They do not establish live provider or R2 asset-store behavior.
- Multiplayer, CRDTs, presence, rich text, embeddings, semantic retrieval, plugin frameworks, workflow execution, automatic regeneration and multi-server infrastructure are deferred.
