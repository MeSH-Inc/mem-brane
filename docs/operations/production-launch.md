# Production launch — September 12, 2026

The private launch is live at <https://mem-brane.com>. Both root and `www` domains
have verified ownership and valid Railway-managed TLS certificates. `www` returns
HTTP 308 to the root origin, preserving the path and query. Porkbun remains the
registrar and authoritative DNS provider; email MX/SPF, ACME records and the
unrelated wildcard parking record were preserved. Only the root ALIAS changed;
an explicit `www` CNAME and two Railway ownership TXT records were added.

## Running infrastructure

- Railway project: `6f309a9d-3a46-4a64-9f63-6c86376bf482` (`mem-brane`).
- Production environment: `898b9759-9ce7-457e-ad78-c52eb081f661`.
- App service: `32142882-16cb-4101-bc0d-91cee061d93b`.
- One continuously running instance in San Francisco, 5,000 MB volume at `/data`.
- Application commit: `9fe2460`; successful deployment:
  `15138483-ccdc-457c-8765-c884568c6b9c`.
- Private backup bucket: `mem-brane-backups`, US West (`sjc`).
- Build: pinned Node 24.13.1 Debian container; application runs as `node`.
- Configuration source: [Railway definition](../../.railway/railway.ts).

[Open the Railway service](https://railway.com/project/6f309a9d-3a46-4a64-9f63-6c86376bf482/service/32142882-16cb-4101-bc0d-91cee061d93b?environmentId=898b9759-9ce7-457e-ad78-c52eb081f661).

Registration requires the reusable invitation code. Authentication and invitation
secrets are stored in Railway variables and private operator files, not git. The
operator invitation file is `~/.local/share/mem-brane/invitation.txt` on the deployment
Mac. Create the owner's account through the live signup screen with an independently
chosen password. The separate deployment smoke account is retained for verification.

Paid execution remains disabled: mock-only generation, zero model/global budgets,
and OCR disabled. No external model billing or OCR provider was exercised.

## Evidence

- Full pre-launch verification: formatting, TypeScript, production build, 440 tests,
  and 123 browser checks passed; two browser checks were skipped.
- Backup follow-up: build/typecheck, formatting, bundle, remote-backup and lifecycle
  tests passed. The remote-backup test extracts and verifies its uploaded archive,
  checks date-scoped retention, and ensures corrupt readback cannot mark success or
  remove earlier backups.
- Both domain ownership records were read back from Porkbun and authoritative DNS.
- Both TLS certificates became valid. Root `/health` returned HTTP 200 and
  `{"status":"ok","app":"mem-brane"}`.
- Public signup without an invitation returned HTTP 403; invited signup returned
  200 with Secure and HttpOnly session cookies.
- The live browser displayed the invitation-code field.
- Authenticated upload/download produced identical image bytes; a text-plus-image
  mock generation completed and persisted its output with zero reserved spend.
- Authenticated SSE delivered its ready event before and after a real container
  restart. Sign-in, workspace blocks, and the image checksum survived the restart.
- Retained smoke workspace: `7c8e80d1-2b63-4009-ab0b-c5873e21d312`; two blocks.
- Retained image SHA-256:
  `1b7e167485e7a59c46bddcb60a9e244bd6514022d3915a5522ea38a4ef706952`.

## Backup and restoration

Managed volume backups require Pro in the current Railway account. No plan upgrade
was made. Instead, the app checks hourly and on startup for its daily UTC backup in
a separate private bucket, with 14-day retention. The first scheduled archive was
created and verified; after restart, the scheduler recognized it as current.

After the smoke test, a forced release archive was uploaded and read back:

- Key: `mem-brane/production/2026-09-12-1ee624a0-c64c-4d47-8cf2-1aa21d1ea6ed.tar.gz`.
- Compressed size: 20,794 bytes.
- SHA-256: `2abb74eb31f15092afb3d9e22452d57f877814edc10ea7139ca74660c25eb7f5`.
- Coverage: one asset, two references, no pending uploads.

Both the first empty archive and the populated release archive were downloaded from
S3 to the Mac, compared against their remote checksum markers, extracted, and
rehearsed using `scripts/rehearse-restore.ts`. The populated restore checked SQL and
asset integrity and exercised HTTP routes on an isolated read-only recovery copy.
Live data and the downloaded backup were left unchanged. Private copies and
transfer receipts live under `~/.local/share/mem-brane/restore-drills/`.

The bucket is separate from the live volume but shares the Railway account. Backup
job failures are logged and retried; external failure notification and a recurring
copy to a second provider/account are not configured. The restore rehearsal proves
portable bundle recovery, not Railway-managed volume-snapshot recovery.

## Recommended next work

Create the owner account and rotate the invitation code after intended users join.
Before opening registration more widely, configure verified email and password
recovery, resolve Better Auth's trusted proxy IP handling (the current deployment
falls back to a shared authentication rate-limit bucket), and add actionable
backup-failure alerts plus an independent account/provider copy. Enable paid models
only after setting an explicit spend ceiling and verified model pricing, then run
one bounded live provider smoke test. Repeat capacity and restore exercises on the
actual production workload before raising concurrency or storage limits.
