# One-VPS deployment

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

`MODEL_PRICING_JSON` maps each allowed paid model to `inputUsdPerMillion`, `outputUsdPerMillion`, `vision`, `imageTokenBound`, `source` (a pricing URL) and `verifiedAt` (YYYY-MM-DD). Configure the actual model's rates from an authoritative source. The image bound must conservatively cover low-detail image input for that model. No paid model is admitted without both pricing and a positive `DAILY_USER_SPEND_LIMIT`. This deployment has been verified only against local fixtures; no paid calls or live R2 writes were authorized.

The Run transaction reserves funds before queueing. Completion with valid usage settles the reservation at frozen rates. Missing usage, interruption and uncertain provider failures retain the full reservation, even on later days. Cancellation before invocation releases it. Retrying explicitly reserves again; it never assumes the earlier request was free.

After verifying provider billing, an operator can resolve uncertainty with an auditable command:

```sh
node --import tsx --env-file-if-exists=.env scripts/reconcile-cost.ts --run RUN_UUID --microusd CONFIRMED_INTEGER --evidence "provider invoice or request reference"
```

One USD equals 1,000,000 micro-USD. Use zero only when provider evidence confirms no charge. The reconciliation record is immutable. Do not use this command merely to bypass an exhausted budget. Structured lifecycle logs and authenticated `/api/operations` expose run state, attempts, leases and accounting status without content or provider secrets.
