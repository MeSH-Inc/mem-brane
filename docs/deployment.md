# Railway deployment at mem-brane.com

The repository includes a pinned Node 24.13.1 Debian Docker image and Railway
configuration. Deploy exactly one always-running service, with a persistent volume
mounted at `/data`. Allocate at least 5 GB: the application keeps 1 GiB free disk
headroom, in addition to database and asset storage. Disable service sleeping.

The image builds UI, API, and operational commands, retains production dependencies
and migrations, prepares volume directory ownership, then runs Node as the
unprivileged `node` user. `/health` gates deployment readiness; allow 25 seconds
for graceful shutdown. Migrations execute at application startup, after the volume
is mounted. Do not run SQLite migrations in a separate pre-deploy container.

Set the variables from `.env.production.example`, with paths
`DATABASE_PATH=/data/mem-brane.sqlite` and `ASSET_DIRECTORY=/data/assets`.
`APP_ORIGIN=https://mem-brane.com`, `HOST=0.0.0.0`, and
`REDIRECT_HOSTS=www.mem-brane.com` keep UI and API on the canonical origin.
`PORT` must match the Railway domain's target port (3001 by default).

Production defaults to closed registration. Set `SIGNUP_MODE=invite` and a separate
random `SIGNUP_INVITE_CODE` of at least 32 characters for private registration.
The UI prompts for the code; the auth hook rejects invalid requests before user
creation, including direct calls to the auth API. This is a reusable invitation:
anyone holding it can register. Rotate the code to revoke unused invitations;
existing accounts remain valid. `SIGNUP_MODE=closed` stops all new registrations,
while `open` deliberately enables public signup. Email ownership verification and
password recovery are not configured. Do not use an email allowlist as proof of
identity. Generate the auth secret and invitation separately and retain them in
private operator storage outside the repository.

Keep `MODEL_DEFAULT=mock`, `MODEL_ALLOWLIST=mock`, zero model/global spend budgets,
and `OCR_PROVIDER=disabled` for the initial infrastructure verification.

In Porkbun, retain its nameservers and configure only the web records:

- Root: ALIAS with blank Host, Answer set to Railway's assigned root-domain target.
- `www`: CNAME pointing to Railway's assigned target for that custom domain.
- Add each ownership TXT record exactly as Railway returns it.
- Replace conflicting parking records for those web hosts. Preserve MX, unrelated
  TXT, and unrelated subdomains. Register both domains in Railway before DNS changes.

Railway supplies HTTPS. The application redirects `www` to the canonical origin,
preserving paths and queries. Volume redeployments have brief downtime and cannot
use replicas. Validate the exact uploaded deployment's successful status before
changing DNS, then verify certificate issuance, `/health`, auth cookies, uploads,
SSE and persistence across a restart.

Enable Railway daily and weekly volume backups. In addition, take a portable,
verified online SQL-plus-assets bundle before releases and periodically retrieve
one to an independent machine for a restore rehearsal:

```sh
# In the deployed container; use a new destination each time.
node dist-ops/backup-bundle.js /data/backup-YYYY-MM-DD
node dist-ops/verify-bundle.js /data/backup-YYYY-MM-DD
# Download the directory/archive, then run locally against that downloaded copy:
node --import tsx scripts/rehearse-restore.ts /downloaded/backup-YYYY-MM-DD
```

Local bundles consume live volume space; move completed bundles off-host and
remove only those verified copies after transfer. Platform snapshots supplement
these portable bundles. A second independent recurring backup destination remains
an operator choice. Keep backup and restore receipts out of logs containing
credentials. No GitHub Actions workflow is required: validate locally and upload
the committed checkout through the Railway CLI.

## One-VPS alternative

Use one Linux VPS with persistent disk, Node 22.13+, Caddy and a dedicated unprivileged `membrane` service user. Deploy the repository (including migrations), run `npm ci` and `npm run build`, and retain production dependencies. Build assets are `dist/` and `dist-server/`. The server resolves migrations and assets relative to its working directory.

Set `NODE_ENV=production`, `APP_ORIGIN=https://your-domain`, a random `BETTER_AUTH_SECRET` of at least 32 characters, `DATABASE_PATH=/var/lib/mem-brane/mem-brane.sqlite`, and `ASSET_DIRECTORY=/var/lib/mem-brane/assets`. Keep the environment file readable only by the service user. Run `npm run db:migrate` before startup; startup also applies pending migrations. Never run the development seed in production.

Caddy terminates HTTPS; the Node process listens on loopback only. V1 assumes UI and API share one origin. An example Caddyfile:

```caddyfile
ideas.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001 {
        flush_interval -1
    }
    header X-Content-Type-Options nosniff
    header Referrer-Policy same-origin
}
```

Avoid proxy buffering for SSE. Long-lived event streams are hints; reconnect fetches current data. Restrict public network ingress to Caddy/SSH. Choose an account signup policy before public exposure. Better Auth provides authentication rate limits; the application has a single-process actor-scoped burst guard. Add edge request controls if exposed broadly.

An example systemd unit (adapt paths and Node installation):

```ini
[Unit]
Description=mem-brane
After=network.target

[Service]
Type=simple
User=membrane
WorkingDirectory=/opt/mem-brane
Environment=NODE_ENV=production
EnvironmentFile=/etc/mem-brane.env
ExecStart=/usr/bin/node /opt/mem-brane/dist-server/main.js
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=25
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/mem-brane

[Install]
WantedBy=multi-user.target
```

Run exactly one server/worker process. SQLite has atomic claims, but the scaffold is not a multi-server lease/fencing system. On shutdown it stops claiming, aborts active work and records interrupted runs. If forcibly killed, lease expiry recovers them conservatively. Never blindly rerun interrupted paid work; provider completion or billing may be uncertain.

## Backups and restoration

Use SQLite's online backup API, not a copy of only the `.sqlite` file while WAL writes are active:

```sh
node --import tsx --env-file-if-exists=.env scripts/backup.ts /safe/backup/mem-brane.sqlite
```

The command runs `integrity_check` on the copy. Back up image bytes as well: SQL references storage keys and is not a binary backup. Keep dated off-host copies with bounded retention, protect them like the live database, and periodically test restoration into an isolated instance. For recovery, stop Node, restore the database and matching assets, validate `PRAGMA integrity_check`, start one process and inspect interrupted runs. Do not restore stale WAL/SHM files alongside a clean backup.

## R2 / S3-compatible storage

Set `R2_ENDPOINT` to your account's S3-compatible HTTPS endpoint, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Restrict credentials to the bucket and required object operations. When the endpoint is absent, filesystem storage is used. Image reads currently pass through authenticated API authorization; the adapter also supports short-lived signed read URLs for a later delivery optimization. Domain types carry opaque asset IDs, never Cloudflare-specific objects.

Backups, object bytes/requests, bandwidth, VPS and model calls are the initial cost centers. Tune global concurrency, per-user active Run limits, output tokens, context size, upload/import bytes, model allowlist and checkpoint settings in `.env.example`. Paid admission requires a positive daily budget and verified per-model pricing. Leave the budget at zero to disable paid models. See the follow-up report for reservation and reconciliation semantics.

## Billing configuration and uncertain requests

`MODEL_PRICING_JSON` maps each allowed paid model to `inputUsdPerMillion`, `outputUsdPerMillion`, `vision`, `imageTokenBound`, `source` (a pricing URL) and `verifiedAt` (YYYY-MM-DD). Configure the actual model's rates from an authoritative source. The image bound must conservatively cover low-detail image input for that model. No paid model is admitted without both pricing and a positive `DAILY_USER_SPEND_LIMIT`. Live provider accounts remain unverified; use the bounded integration smoke test below with configured credentials.

The Run transaction reserves funds before queueing. Completion with valid usage settles the reservation at frozen rates. Missing usage, interruption and uncertain provider failures retain the full reservation, even on later days. Cancellation before invocation releases it. Retrying explicitly reserves again; it never assumes the earlier request was free.

After verifying provider billing, an operator can resolve uncertainty with an auditable command:

```sh
node --import tsx --env-file-if-exists=.env scripts/reconcile-cost.ts --run RUN_UUID --microusd CONFIRMED_INTEGER --evidence "provider invoice or request reference"
```

One USD equals 1,000,000 micro-USD. Use zero only when provider evidence confirms no charge. The reconciliation record is immutable. Do not use this command merely to bypass an exhausted budget. Structured lifecycle logs and authenticated `/api/operations` expose run state, attempts, leases and accounting status without content or provider secrets.

## Admission and restoration controls

Paid admission requires positive `GLOBAL_DAILY_SPEND_LIMIT` and
`GLOBAL_MONTHLY_SPEND_LIMIT` values as well as the per-user model limit. Outstanding and uncertain liabilities across all actors count toward
these shared model/OCR operator budgets. Defaults keep paid execution disabled.
Optional `MODEL_DAILY_SPEND_LIMIT` and `MODEL_MONTHLY_SPEND_LIMIT` add model-category
ceilings. OCR category ceilings default to $10/day and $100/month; paid OCR remains
disabled by default. Explicit `OCR_PROVIDER=mistral`, a server `MISTRAL_API_KEY`,
positive shared/category budgets and granted credits are required. Follow the
deliberately authorized one-page pilot in [OCR controls](ocr-admission.md) before
activating paid processing; local verification uses a blocked-network fixture.

`RUN_QUEUE_LIMIT` caps active/queued generations (default 8). Imports have global
and actor limits (`IMPORT_QUEUE_LIMIT=6`, `USER_IMPORT_LIMIT=3`). Image bytes,
including outstanding upload intents, are reserved against `USER_STORAGE_BYTES`
(default 100 MiB) and `TOTAL_STORAGE_BYTES` (default 1 GiB) before object writes.
Each actor can create 100 branes; each brane supports 200 placements. Workspace reads
retain runs for visible output blocks, active work, and the latest 100 runs. These
bounds do not delete historical records.

Uncommitted uploads keep durable intents even after a crash or ambiguous storage
failure. To release them, stop the server, wait for outstanding object writes to
settle, and run:

```sh
node --import tsx scripts/reconcile-uploads.ts --offline
```

This deletes only keys recorded in upload intents and releases their reservations;
committed assets are protected. Do not run concurrently with the application.

Verify an isolated restored SQLite backup and its copied local image directory:

```sh
node --import tsx scripts/verify-restore.ts /restore/mem-brane.sqlite /restore/assets
```

The verifier opens SQL read-only, checks database and foreign-key integrity, reads
every committed asset, and verifies sizes and hashes referenced by live content and
immutable revisions. Pending uploads are reported separately. For R2, export the
matching object keys into that directory first. The local test suite performs an
online backup, copies images, removes the original image directory, validates the
restore, then confirms that missing and corrupted bytes are detected.

## Measured capacity and disk admission

The capacity exercise and its machine-specific results are recorded in
[the capacity report](operations/capacity.md). Current defaults admit eight active
or queued generation runs, six webpage imports globally and three per actor.
Workspaces admit 200 placements. Artifact text is limited to 20,000 characters and
serialized content to 32 KiB, including multibyte characters and JSON escaping.
These limits also apply to ingestion and generated output. Existing records are
not automatically truncated or deleted.

`MIN_FREE_DISK_BYTES` defaults to 1 GiB on each local database/image filesystem.
`DISK_CHECK_INTERVAL_MS` defaults to 15 seconds. A low, failed or stale probe makes
`/health` return 503 and pauses new mutating requests and background claims. Reads,
run cancellation and sign-out remain available; existing work may checkpoint and
finalize using the reserved headroom. Recovery from low space requires 25% additional
headroom. This is an admission guard with a sampling interval, not a guarantee
against another process exhausting the disk between probes.

JSON `disk_state` logs record transitions and repeated unavailable samples.
`runtime_sample` logs every ten seconds report sampled RSS, event-loop delay and
queue age; `TELEMETRY_INTERVAL_MS` controls this interval. No artifact content is
logged. The [retention policy](operations/retention.md) describes bounded cleanup
and the records preserved indefinitely.

## Complete backup bundles and off-host rehearsal

Create a new private directory containing an online SQLite snapshot, exactly the
committed image keys in that snapshot, checksums, and a completion manifest:

```sh
node --import tsx --env-file-if-exists=.env scripts/backup-bundle.ts /new/backup-directory
node --import tsx scripts/verify-bundle.ts /new/backup-directory
```

The manifest is published last. A partial directory without `manifest.json` is not
a complete backup. Source images remain immutable and are copied after the SQL
snapshot; uploads committed later are outside that snapshot. Verification streams
file checksums, checks SQLite integrity and foreign keys, and verifies image hashes
against both live state and revisions.

FluffyFleet identifies Cachy's SSH alias as `fluffycachy-worker` (user `fluffyr`).
A bounded transfer and retrieval drill can use:

```sh
python3 scripts/offhost-rehearsal.py fluffycachy-worker /new/backup-directory /new/download-directory /new/receipt.json
node --import tsx scripts/rehearse-restore.ts /new/download-directory
```

The transfer uses a new owner-private directory beneath
`~/.local/share/mem-brane/backup-rehearsals`, verifies checksums and SQL on the remote
host, and retrieves the bundle. It never copies repository working directories or
modifies the fleet worker. SSH must be non-interactive with an established trusted
host key. No recurring backup schedule or remote deletion policy is installed.

The HTTP rehearsal verifies the downloaded bundle, copies it into a disposable
restore directory, applies migrations there, creates a probe session only in that
copy, and starts the built application with `READ_ONLY=1`. This mode blocks mutating
HTTP and disables workers and retention; queued historical jobs cannot invoke a
provider. It is an application recovery mode, not a SQLite read-only connection:
startup migrations and session preparation operate on the disposable copy. The
original bundle and live database are untouched.

Use `scripts/fixture-bundle.ts /new/fixture-directory` for synthetic drills.
The September 8 rehearsal completed remote verification, retrieval and four HTTP
checks using synthetic image/provenance data; see
[the transfer receipt](operations/offhost-receipt.json).

## Production configuration and live integration smoke test

Use `.env.production.example` as the deployment environment template. Generate a
random authentication secret and set the actual HTTPS origin and persistent paths.
Run `npm run check:production` with those environment values loaded. This checks
configuration structure without printing secrets or making provider requests.
`npm run build` itself does not require provider keys.

Live generation requires `OPENAI_API_KEY`, allowed model IDs, operator-verified
pricing/capabilities and positive user/global daily/global monthly budgets. Local
file storage needs no additional key. R2 requires all four R2 settings. Enhanced
OCR now has a pinned provider adapter but remains disabled by default; its live
credential, recognition and billing check has not been run. Checkout and email
recovery still have no enabled provider configuration.

`npm run smoke:live` exercises the deployed API under a test account. Supply
`SMOKE_ORIGIN`, `SMOKE_EMAIL`, `SMOKE_PASSWORD`, and optionally `SMOKE_MODEL` through
your shell or secret manager. It signs in, creates a visibly named smoke brane,
uploads/downloads a tiny red PNG, verifies identical bytes, estimates a text plus
image request, submits it, and checks completion and accounting. The selected
model must support vision. The script retains the brane and run for inspection and
signs out its own session when finished.

The default maximum reservation is $0.05; `SMOKE_MAX_USD` can lower it or raise it
up to $1. `maxReservedMicrousd` is also submitted to the server, which rejects a
changed quote above that ceiling before edits, snapshots or spend reservations
commit. A reservation ceiling is based on configured conservative pricing; it is
not a substitute for correct provider rates. The script does not automatically
retry a model request or assume that a timed-out provider request was free.

For a local rehearsal only, use the seeded account with
`SMOKE_ORIGIN=http://localhost:5173` and run `npm run smoke:live -- --allow-mock`.
This proves the API/storage flow with a deterministic provider; it does not verify
OpenAI or R2. Live provider credentials were absent during the PWA implementation,
so live-account behavior remains unverified until the real smoke command passes.

Keep secrets on the Node server. The browser uses same-origin session cookies and
never receives an operator provider key. Do not put provider credentials in
`VITE_*` variables or the PWA manifest.
