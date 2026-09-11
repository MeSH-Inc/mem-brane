# mem-brane

A spatial workspace for thinking with artifacts and AI. Create a **brane**, arrange text, images, PDFs and imported webpages, then develop an artifact or compose an exploration with explicit context. Generated artifacts retain the exact source revisions that produced them.

This is a greenfield, single-server application under active development. The default **mock** model streams deterministic text locally without provider credentials or model spend. Live OpenAI and R2 integrations are implemented, but have not been verified against live accounts.

## Quick start

Use Node.js 22.13+ and npm. Local verification currently uses Node 24.13.1 and npm 11.18.0 on macOS. The SQLite dependency, `better-sqlite3`, needs a compatible native binary; if a prebuilt binary is unavailable, installation requires your platform's C/C++ build tools.

```sh
git clone https://github.com/MeSH-Inc/mem-brane.git
cd mem-brane
npm ci
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

Open [localhost:5173](http://localhost:5173). The optional development seed creates:

- Email: `hello@mem-brane.local`
- Password: `mem-brane-local-only`

Set `SEED_EMAIL` and `SEED_PASSWORD` to override those credentials, or skip the seed and create an account in the interface. Never use the development seed for production.

Vite serves the browser on port 5173 and proxies `/api` to the Node server on port 3001. Use `localhost` to match `APP_ORIGIN`. If you change the browser hostname, update that setting too. Run commands from the repository root: migrations, browser assets and default data paths resolve from the working directory.

## First exploration

1. Open the seeded brane or choose **New brane**.
2. In Canvas, choose **Write** and click or drag empty space to create a thought. Type into its editor. In Focus, use the add controls instead.
3. Choose **Spawn** on a ready artifact to develop it into a generated child. Spawn captures the source's current text and creates a new artifact with provenance; it does not read the global composer or inherit a conversation automatically.
4. For a composed exploration, choose **Use as context**, order your references, write a prompt and submit. **Continue from here** explicitly selects a conversation's ancestor chain.
5. Use **Save brane** to flush pending text and placement edits and save the title. Background runs continue when you navigate away.

The mock model exercises streaming and persistence but does not perform reasoning or image understanding.

## Import images and PDFs

Paste a screenshot, drop files onto the canvas, or use **Image / PDF**. The **+** button in the prompt attaches files as explicit context. Text paste keeps normal editor behavior. Pending imports show previews, survive navigation and can be recovered after reload; Retry reuses the original import identity.

PNG, JPEG, GIF, WebP and PDF files are supported, up to 5 MiB by default. Original files are retained. PDFs expose extracted text by page and work as text context with every configured model. PDF images, diagrams and layout are not included; scanned PDFs need OCR, which is not yet supported. Documents beyond extraction limits remain downloadable without sending partial text. Animated images are stored but require a still image for model context.

The enhanced-OCR admission layer is implemented but disabled: no paid OCR provider or
checkout is connected. It provides a shared model/OCR spend ledger, one-time invited
trial grants, operator-verified prepaid credits, and durable parsing jobs. Ordinary
uploads still use local PDF.js. See [OCR admission and credits](docs/ocr-admission.md)
for limits, API contracts, and operator commands.

## Canvas and Focus

| Tool   | Primary drag                                    | Other behavior                                                                      |
| ------ | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Write  | Size a thought on empty canvas                  | Click empty canvas to create; drag headers to move cards; resize selected cards     |
| Pan    | Move the viewport, including from a card header | Editors and block actions remain interactive; card movement and resize are disabled |
| Select | Select cards intersecting a marquee             | Shift-click toggles individual placements; drag a selected header to move the group |

Middle/right mouse panning remains available across tools. Use Fit View to find offscreen cards. Editor text gestures do not move cards. Select is the default tool. Escape, tool changes, blur and pointer cancellation abort creation, selection, movement and resizing without saving; cancellation restores the previous selection. Wheel gestures pan; Control/Command-wheel zooms around the pointer.

Selection belongs to placements: two instances of the same block can be selected independently. **Use as context** resolves that selection to unique blocks. Selection, proximity, movement and resizing never invoke a model or implicitly change context.

Mobile defaults to **Focus**, with a full-width editor, horizontal block outline, tap-to-add, image picker and brane navigation. Canvas is an optional overview, with touch viewport panning. Canvas rendering is lazy. In production, PWA installation also precaches Canvas code and styles in the background so it can open offline. A focused link has the form `/b/:braneId?focus=:blockId&view=focus`.

## Local verification and development

Install the three browser engines once before running browser checks, and repeat after a Playwright update that requires new browser binaries:

```sh
npx playwright install chromium firefox webkit
npm run verify
```

On Linux, if browser system libraries are missing, use `npx playwright install --with-deps chromium firefox webkit` to install the browsers and required system packages.

`npm run verify` stops at the first failure and runs, in order:

1. Formatting checks.
2. TypeScript checking and production builds for browser and server.
3. Vitest unit and integration tests.
4. Playwright browser tests: the full suite in Chromium and canvas, geometry, selection, presentation, loading and native-input checks in Firefox and WebKit.

The checks use temporary databases, mock providers and fixture APIs; no `.env`, seeded database or paid credentials are required. Playwright starts its own Vite server on `127.0.0.1:4179`, so leave that port available. Browser tests include intercepted canvas APIs and an isolated built-server flow through authentication, text saving, generation, SSE reconciliation and session expiration. They do not exercise live provider accounts. The mixed-media workspace rehearsal also covers composer/title recovery, independent tabs, branching and historical provenance. Additional drills cover interrupted two-tab edits and uncertain Run/Spawn delivery across reload. Ports 4179, 4181, 4183, 4185, 4187, 4189, 4191 and 4193 must be available.

Development currently favors direct architectural improvements over compatibility scaffolding. Make focused, atomic commits directly to `main`, verify changes locally before committing, and run `npm run verify` before pushing. GitHub Actions is deferred until it provides a concrete benefit such as catching platform differences, shared verification across independent contributors, or repeatable release artifacts.

| Command                | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `npm run dev`          | Browser, API and background workers in watch mode    |
| `npm run dev:web`      | Vite only                                            |
| `npm run dev:server`   | API and workers only                                 |
| `npm run db:migrate`   | Apply pending SQLite migrations                      |
| `npm run db:seed`      | Create the development account and initial brane     |
| `npm test`             | Unit and integration tests                           |
| `npm run test:browser` | Chromium suite and Firefox/WebKit interaction tests  |
| `npm run typecheck`    | TypeScript validation                                |
| `npm run format`       | Format application code, tests and documentation     |
| `npm run format:check` | Check formatting without writing                     |
| `npm run build`        | Typecheck and build `dist/` and `dist-server/`       |
| `npm run verify`       | Complete local pre-push checks                       |
| `npm start`            | Serve the built browser, API and workers on loopback |

## Configuration

For production, start with [.env.production.example](.env.production.example), run `npm run check:production`, and follow the [bounded integration smoke test](docs/deployment.md#production-configuration-and-live-integration-smoke-test). For installation and offline behavior, see [the PWA guide](docs/offline-pwa.md).

[.env.example](.env.example) lists defaults. Local data lives under ignored `data/`; dependencies, build outputs, browser test output and `.env` are also ignored.

| Settings                                                               | Purpose                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PORT`, `APP_ORIGIN`                                                   | Server port and trusted browser origin                                           |
| `BETTER_AUTH_SECRET`                                                   | Authentication secret; replace the example value for deployed use                |
| `DATABASE_PATH`, `ASSET_DIRECTORY`                                     | SQLite database and local image bytes                                            |
| `MODEL_ALLOWLIST`, `MODEL_DEFAULT`                                     | Comma-separated allowed models and selected default; default must be allowlisted |
| `OPENAI_API_KEY`                                                       | Credentials for real OpenAI invocation                                           |
| `DAILY_USER_SPEND_LIMIT`, `MODEL_PRICING_JSON`                         | Paid admission limit and verified model pricing/capabilities                     |
| `WORKER_CONCURRENCY`, `USER_RUN_LIMIT`                                 | Global worker concurrency and per-user active-run limit                          |
| `MAX_OUTPUT_TOKENS`, `MAX_CONTEXT_CHARACTERS`                          | Model output and context bounds                                                  |
| `MAX_WEBPAGE_BYTES`, `MAX_UPLOAD_BYTES`                                | Import and image upload bounds                                                   |
| `CHECKPOINT_INTERVAL_MS`, `CHECKPOINT_CHARACTERS`, `LEASE_MS`          | Streaming persistence and worker recovery timing                                 |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Optional S3-compatible object storage; absent endpoint selects local files       |

To enable real models, supply `OPENAI_API_KEY`, add the model ID to `MODEL_ALLOWLIST`, configure its operator-verified entry in `MODEL_PRICING_JSON`, and set positive `DAILY_USER_SPEND_LIMIT`, `GLOBAL_DAILY_SPEND_LIMIT` and `GLOBAL_MONTHLY_SPEND_LIMIT` values. Optionally change `MODEL_DEFAULT`. A zero budget disables paid admission. Pricing entries include input/output token rates, vision capability, an image token bound, source URL and verification date; see [billing configuration](docs/deployment.md#billing-configuration-and-uncertain-requests).

Paid admission atomically reserves a conservative usage bound. Recorded costs use frozen configured rates, not provider invoices. Interrupted or unmetered requests retain their reservations until explicit, audited reconciliation. Retrying never assumes the previous request was free.

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

Text autosave uses version checks. IndexedDB retains recoverable drafts with their original server version, scoped by actor and block. Text conflict recovery offers server text or explicit overwrite. Completed placement intents and ordinary workspace mutations commit to an account-scoped IndexedDB replica and outbox before synchronization. Replica replay follows entity dependencies instead of an account-wide queue. Cancellation bypasses local writes and conflicts, and new server output can refresh around pending edits. Opened workspaces support offline reload and editing; reconnect conflicts require an explicit choice. This is not automatic merging or multiplayer collaboration. See [offline PWA behavior](docs/offline-pwa.md).

## Background work

One server process runs SQLite-backed generation and webpage-import workers. Generation submission deduplicates per-user request keys, and workers claim queued runs atomically, maintain leases and checkpoint streamed text. Provider calls run outside database transactions.

One authenticated browser SSE connection multiplexes updates. Reconnection reloads authoritative state, so final results survive missed events. Navigation does not cancel work. Explicit retry creates a new run from the original frozen inputs. Retrying an uncertain Run or Spawn submission reuses its journaled request and key across navigation and reload; that is separate from retrying a failed generation.

Expired claims can be requeued before invocation. Expired running work becomes interrupted and is never automatically retried because provider completion and billing may be uncertain. Shutdown aborts active calls best-effort and records interruption. Run exactly one server/worker process; this is not a distributed worker system.

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
server/storage/     filesystem and S3-compatible adapters
server/ingestion/   bounded, DNS-pinned webpage imports
shared/             domain types, command schemas and public response contracts
migrations/         schema changes and immutable-history guards
scripts/            migration, seed, backup and cost reconciliation
tests/              unit, API, migration, recovery and invariant tests
e2e/                browser fixtures and interaction tests
docs/architecture/  design boundaries and invariants
```

## Running the built application

For a local production-build smoke test, keep development mode and point authentication at the built application's origin:

```sh
npm run build
APP_ORIGIN=http://localhost:3001 npm start
```

Open [localhost:3001](http://localhost:3001). `/health` returns a basic process health response. Startup applies pending migrations automatically; the explicit migration command is useful during setup and before starting a new build.

For a hosted instance, follow the [single-VPS operations guide](docs/deployment.md): use HTTPS, `NODE_ENV=production`, the public `APP_ORIGIN`, a random authentication secret, persistent database/assets paths and one server process. The Node listener binds to `127.0.0.1`; a reverse proxy provides public access. Keep the repository's migrations and production dependencies alongside build output.

Back up SQLite through the online backup script and back up image bytes separately. A database backup alone does not contain uploaded images. The operations guide covers restoration, SSE proxying, storage configuration and audited cost reconciliation.

## Current boundaries

- Webpage imports use lightweight text extraction, without browser rendering or a rich readability parser. HTTP(S) targets and redirects are validated, DNS is pinned, and time/byte limits apply. Failed imports permit pasted text.
- Image context resolves authorized bytes using frozen asset IDs and SHA-256 hashes. Paid models must explicitly support vision in the pricing catalog; image requests use low detail.
- Public signup is enabled. Invitation policy, email delivery, email verification and password recovery are not implemented in this slice.
- Local tests cover mock execution, adapter fixtures, authenticated APIs, migrations, worker crash recovery and browser interactions. They do not establish live OpenAI/R2 behavior or production readiness.
- Multiplayer, CRDTs, presence, rich text, embeddings, semantic retrieval, plugin frameworks, workflow execution, automatic regeneration and multi-server infrastructure are deferred.

## Design references

Start with [principles](docs/architecture/00-principles.md) and [invariants](docs/architecture/01-invariants.md). The architecture directory also covers [domain modeling](docs/architecture/02-domain-model.md), [snapshots](docs/architecture/03-snapshot-semantics.md), [run lifecycle](docs/architecture/04-run-lifecycle.md), [client state and save queues](docs/architecture/05-client-state.md), [future collaboration](docs/architecture/06-collaboration-migration.md), [costs](docs/architecture/07-cost-model.md), [security](docs/architecture/08-security.md), [non-goals](docs/architecture/09-non-goals.md), [artifact derivation](docs/architecture/10-artifact-derivation.md), and [artifact imports and representations](docs/architecture/11-artifact-imports.md).

The [scaffold report](docs/scaffold-report.md) and [follow-up implementation notes](docs/follow-up-report.md) are historical implementation records. Use the current source, scripts and architecture documents for present behavior.

Operational limits, durable upload reconciliation, run deadlines, and the database-plus-assets restore verifier are documented in [the operations guide](docs/deployment.md#admission-and-restoration-controls).

Command types derive from their schemas; HTTP responses are validated through typed client methods. See [type boundaries](docs/architecture/14-type-boundaries.md) for persistence records, public DTOs and local contract verification.
