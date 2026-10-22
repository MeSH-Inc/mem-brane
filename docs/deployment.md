# Deploying mem-brane.com

Production runs as one container on `apps-1` (Hetzner), deployed with Kamal 2 from
this Mac and reached only through Cloudflare Tunnel. Server bootstrap, the
Cloudflare tunnel and R2 setup, Keychain secrets and DNS cutover are shared with
the other self-hosted apps and documented in `~/apps/selfhost/README.md`. This
guide covers what is specific to mem-brane.

```txt
visitor ─TLS─▶ Cloudflare edge ─tunnel─▶ cloudflared ─▶ kamal-proxy 127.0.0.1:80 ─▶ mem-brane:3001
                                                         Litestream ─▶ R2 mem-brane-backup/db/
```

## Configuration

| File                        | Purpose                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `config/deploy.yml`         | Host, proxy, non-secret environment, volume and timeouts                 |
| `.kamal/secrets`            | Keychain lookups under `kamal/mem-brane`; no secret values are committed |
| `.kamal/hooks/pre-app-boot` | Stops the running container before its replacement boots                 |
| `Dockerfile`                | Pinned Node 24 Debian image with Litestream and the operational commands |
| `deploy/entrypoint.sh`      | Prepares `/data`, restores an empty volume, runs Node under Litestream   |
| `deploy/litestream.yml`     | Continuous SQLite replication to R2                                      |

Store each secret named in `config/deploy.yml` with `~/apps/selfhost/keychain-secret`,
then confirm none resolve empty:

```sh
kamal secrets print | grep '=$'
```

Kamal builds the committed `HEAD`; uncommitted changes are not deployed. Run Kamal
with OrbStack's Docker engine (see the selfhost README), using `kamal setup` the
first time and `kamal deploy` afterwards:

```sh
env -u DOCKER_HOST kamal deploy
```

Run `npm run verify` before every deploy. No CI workflow is involved.

## Runtime behavior

- **One process.** The pre-app-boot hook stops the old container first, trading a
  few seconds of 502s per deploy for never running two writers or two Litestream
  processes against one volume. SQLite has atomic claims, but this is not a
  multi-server lease/fencing system. On shutdown the server stops claiming, aborts
  active work and records interrupted runs; after a forced kill, lease expiry
  recovers them conservatively. Never blindly rerun interrupted paid work.
- **Startup.** The entrypoint restores the latest Litestream replica if the volume
  has no database, runs `check-production`, then starts Node. Migrations execute at
  application startup after the volume is mounted. `deploy_timeout` (180 s) covers
  a restore; `drain_timeout` (25 s) covers `SHUTDOWN_MS` (20 s). `/health` gates
  readiness.
- **Proxy.** TLS ends at Cloudflare. `TRUST_PROXY=cloudflare` makes rate limits use
  `CF-Connecting-IP`, which is only trustworthy because nothing reaches the origin
  except through the tunnel. kamal-proxy response buffering is disabled and its
  response timeout (330 s) exceeds the 300 s run deadline, so SSE streams flush.
- **Origin.** `APP_ORIGIN=https://mem-brane.com`; `REDIRECT_HOSTS=www.mem-brane.com`
  redirects `www` to the canonical origin, preserving paths and queries. Both
  hostnames need a tunnel public hostname pointing to `http://localhost:80`.
- **Storage.** The `mem-brane-data` volume holds `/data/mem-brane.sqlite` and
  `/data/assets`. The application keeps 1 GiB free disk headroom.

## Signup and models

Production uses `SIGNUP_MODE=invite` with a separate random `SIGNUP_INVITE_CODE`
of at least 32 characters. The auth hook rejects invalid requests before user
creation, including direct calls to the auth API. Anyone holding the code can
register; rotate it to revoke unused invitations. `closed` stops new registrations
and `open` enables public signup. Email ownership is not verified; do not use an
email allowlist as proof of identity.

Generation uses `deepseek-flash` with `DEEPSEEK_API_KEY`, operator-verified
`MODEL_PRICING_JSON`, and small positive per-user, global daily and global monthly
budgets (see `config/deploy.yml`). Set the budgets to zero to disable paid models.

## Backups and restoration

Two jobs write to the private `mem-brane-backup` R2 bucket with one scoped token:

- **Litestream** replicates the database continuously under `db/`, with a
  daily snapshot and 30 days of point-in-time history. It covers the database only.
- **Hourly bundle job** (`BACKUP_*`) creates one portable SQL-plus-assets bundle
  per UTC day under `mem-brane/production/`. It validates the local bundle, uploads
  the compressed archive, reads it back to verify SHA-256, and publishes a
  `.verified` marker only after verification. Unverified uploads are retried. Only
  this deployment's dated objects older than 14 days are expired, and only after a
  new verified backup succeeds. The job runs for at most five minutes; failures
  emit `backup_job_failed` and `remote_backup_failed` and retry on the next hourly
  check. Read-only recovery mode disables the scheduler. The application stays
  available on backup failure.

Take a release backup with `kamal app exec --reuse "node dist-ops/backup-remote.js --force"`,
which creates a unique dated object even if today's backup exists. Download an
archive to an independent machine, extract it, and run the restore rehearsal
described below.

To recover the database alone, stop the app, remove the volume's database (and any
stale `-wal`/`-shm` files), and boot: the entrypoint restores the latest replica.
To recover assets too, restore a verified bundle into the volume first. Validate
`PRAGMA integrity_check`, start one process and inspect interrupted runs.

For an ad-hoc online copy outside the container, use SQLite's backup API rather than
copying the file while WAL writes are active:

```sh
node --import tsx --env-file-if-exists=.env scripts/backup.ts /safe/backup/mem-brane.sqlite
```

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
node --import tsx --env-file-if-exists=.env scripts/reconcile-uploads.ts --offline
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

Live generation requires the provider key for each allowed model (`DEEPSEEK_API_KEY` for `deepseek-*`, otherwise `OPENAI_API_KEY`), allowed model IDs, operator-verified
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
a live provider or R2. The R2 asset store and OpenAI models have not been verified
against live accounts.

Keep secrets on the Node server. The browser uses same-origin session cookies and
never receives an operator provider key. Do not put provider credentials in
`VITE_*` variables or the PWA manifest.
