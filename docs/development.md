# Development

Project rules (greenfield refactoring, atomic commits to `main`, local verification instead of CI) are in `AGENTS.md`.

## Verification

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

The checks use temporary databases, mock providers and fixture APIs; no `.env`, seeded database or paid credentials are required. Test server processes ignore local `.env` files and inherited deployment, backup, mail and provider settings. Application commands load `.env` explicitly at their entry point. Playwright starts its own Vite server on `127.0.0.1:4179`, so leave that port available. Browser tests include intercepted canvas APIs and an isolated built-server flow through authentication, text saving, generation, SSE reconciliation and session expiration. They do not exercise live provider accounts. The mixed-media workspace rehearsal also covers composer/title recovery, independent tabs, branching and historical provenance. Additional drills cover interrupted two-tab edits and uncertain Run/Spawn delivery across reload. Ports 4179, 4181, 4183, 4185, 4187, 4189, 4191, 4193, 4195 and 4199 must be available.

Run `npm run test:stress` separately, with port 4180 free, to measure 500 mounted cards under four streams, delayed saves and geometry conflicts. It runs production profiling builds serially across all three engines and writes `artifacts/stress/latest.md` and `latest.json`. See the [interaction verification guide](interaction-verification.md) for measurement definitions, the interactive fixture and the pending physical-device protocol.

| Command                  | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `npm run dev`            | Browser, API and background workers in watch mode    |
| `npm run dev:web`        | Vite only                                            |
| `npm run dev:server`     | API and workers only                                 |
| `npm run db:migrate`     | Apply pending SQLite migrations                      |
| `npm run db:seed`        | Create the development account and initial brane     |
| `npm test`               | Unit and integration tests                           |
| `npm run test:browser`   | Chromium suite and Firefox/WebKit interaction tests  |
| `npm run test:stress`    | 500-card responsiveness and render-isolation checks  |
| `npm run preview:stress` | Interactive stress fixture on port 4180              |
| `npm run typecheck`      | TypeScript validation                                |
| `npm run format`         | Format application code, tests and documentation     |
| `npm run format:check`   | Check formatting without writing                     |
| `npm run build`          | Typecheck and build `dist/` and `dist-server/`       |
| `npm run verify`         | Complete local pre-push checks                       |
| `npm start`              | Serve the built browser, API and workers on loopback |

## Configuration

For production, start with [.env.production.example](../.env.production.example), run `npm run check:production`, and follow the [bounded integration smoke test](deployment.md#production-configuration-and-live-integration-smoke-test). For installation and offline behavior, see [the PWA guide](offline-pwa.md).

[.env.example](../.env.example) lists defaults. Local data lives under ignored `data/`; dependencies, build outputs, browser test output and `.env` are also ignored.

| Settings                                                               | Purpose                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PORT`, `APP_ORIGIN`                                                   | Server port and trusted browser origin                                           |
| `BETTER_AUTH_SECRET`                                                   | Authentication secret; replace the example value for deployed use                |
| `DATABASE_PATH`, `ASSET_DIRECTORY`                                     | SQLite database and local image bytes                                            |
| `MODEL_ALLOWLIST`, `MODEL_DEFAULT`                                     | Comma-separated allowed models and selected default; default must be allowlisted |
| `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`                                   | Provider credentials; `deepseek-*` models use DeepSeek, others OpenAI            |
| `DAILY_USER_SPEND_LIMIT`, `MODEL_PRICING_JSON`                         | Paid admission limit and verified model pricing/capabilities                     |
| `WORKER_CONCURRENCY`, `USER_RUN_LIMIT`                                 | Global worker concurrency and per-user active-run limit                          |
| `MAX_OUTPUT_TOKENS`, `MAX_CONTEXT_CHARACTERS`                          | Model output and context bounds                                                  |
| `MAX_WEBPAGE_BYTES`, `MAX_UPLOAD_BYTES`                                | Import and image upload bounds                                                   |
| `CHECKPOINT_INTERVAL_MS`, `CHECKPOINT_CHARACTERS`, `LEASE_MS`          | Streaming persistence and worker recovery timing                                 |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Optional S3-compatible object storage; absent endpoint selects local files       |

To enable real models, supply the provider key, add the model ID to `MODEL_ALLOWLIST`, configure its operator-verified entry in `MODEL_PRICING_JSON`, and set positive `DAILY_USER_SPEND_LIMIT`, `GLOBAL_DAILY_SPEND_LIMIT` and `GLOBAL_MONTHLY_SPEND_LIMIT` values. Optionally change `MODEL_DEFAULT`. A zero budget disables paid admission. Pricing entries include input/output token rates, vision capability, an image token bound, source URL and verification date; see [billing configuration](deployment.md#billing-configuration-and-uncertain-requests).

Paid admission atomically reserves a conservative usage bound. Recorded costs use frozen configured rates, not provider invoices. Interrupted or unmetered requests retain their reservations until explicit, audited reconciliation. Retrying never assumes the previous request was free.

## Running the built application

For a local production-build smoke test, keep development mode and point authentication at the built application's origin:

```sh
npm run build
APP_ORIGIN=http://localhost:3001 npm start
```

Open [localhost:3001](http://localhost:3001). `/health` returns a basic process health response. Startup applies pending migrations automatically; the explicit migration command is useful during setup and before starting a new build.
