# Password recovery and backup alerts

Delivery is disabled until `RESEND_API_KEY` and `MAIL_FROM` are configured
together. `MAIL_FROM` must be a verified sender's bare email address. Set
`BACKUP_ALERT_EMAIL` to the operator's email to enable backup notifications.
Partial or malformed settings fail startup and the production config check.
The implementation uses the [Resend send API](https://resend.com/docs/api-reference/emails/send-email)
and [Better Auth password recovery](https://better-auth.com/docs/authentication/email-password).
No provider account, sender domain, credentials or recipients are provisioned
automatically. These settings are not configured on production as of September 18.

The sign-in screen offers recovery only when the server has delivery configured.
Recovery requests return the same response for known and unknown accounts.
Known accounts enqueue a reset email in SQLite; the HTTP path does not wait on
the provider. Redirect destinations are fixed to the application origin. Tokens
travel in the URL fragment, are removed from browser history on load, expire
after 15 minutes, and are consumed once by Better Auth. Reset revokes existing
sessions. Recovery does not verify an account's email for other product purposes.

The mail worker polls every five seconds, atomically leases one queued message,
and retries delivery with exponential backoff capped at five minutes. Requests
use a ten-second timeout, reject redirects and reuse the immutable queue ID as
the provider idempotency key. Queued messages survive restarts; expired messages
are deleted without transmission. Accepted messages are deleted, including the
reset link. Reset requests are limited to three per minute by the auth limiter.
The existing production trusted-proxy limitation still means clients may share
a limiter bucket; do not widen proxy trust without infrastructure evidence.

A failed backup process queues one incident notification, with at most one
reminder daily until success. Incident state and queue insertion share one
SQLite transaction. A subsequent successful job queues recovery and clears
the incident; normal shutdown does not produce failure notifications. Operational
messages expire after one day. The provider acceptance receipt proves acceptance,
not inbox delivery. Provider failures and expired messages produce redacted logs.

This is in-process monitoring: a dead app, unavailable database or broken mail
provider cannot reliably alert through this path. Add an independent missed-
backup heartbeat monitor before treating notifications as complete outage coverage.
Backups can contain short-lived reset credentials in the queue and auth tables;
keep archives private, rehearse restoration with `READ_ONLY=1`, and review pending
mail before opening any restored copy for writes.

## Activation and acceptance

1. Choose/verify the sender and configure the three variables in the production
   service's private Railway configuration. Never commit credentials or tokens.
2. Build/typecheck, run password recovery, mail, backup and lifecycle tests, then
   run the browser recovery test. Deploy the exact verified commit.
3. With the operator's explicit test recipient, request one reset, confirm inbox
   delivery and perform the password change personally. Verify the prior session
   expires and the same link cannot reset again.
4. Exercise failure and recovery against a disposable backup target; confirm one
   failure, no repeated hourly noise, and one recovery. Do not break production
   backup credentials to run this test.
5. Configure independent missing-heartbeat detection and verify its delivery.
   Keep paid AI/OCR disabled until those checks and a specific spend ceiling are
   complete; then select one model/pricing record for a bounded live trial.
