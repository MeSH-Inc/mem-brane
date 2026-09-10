# Enhanced PDF parsing: admission and page credits

## Current boundary

The shared spend ledger, OCR admission API, credit grants, and durable job executor
are implemented. Production constructs the service without a provider, reports
`enabled: false`, and rejects new enhanced-parsing quotes/submissions with 503.
There is no payment processor, public checkout, paid OCR request, or parsing button
connected yet. Existing local PDF.js imports and extracted-text context continue
to work. Operator grant commands support an invited pilot and manually verified
prepaid receipts; they do not themselves collect or verify a payment.

## Default limits

| Limit                                         | Value                                                  |
| --------------------------------------------- | ------------------------------------------------------ |
| Automatic credits for anonymous/free accounts | None                                                   |
| Operator-invited trial                        | Exactly 50 pages, once per account                     |
| Prepaid credits                               | Explicit operator grant referencing a verified payment |
| Upload bytes                                  | Existing `MAX_UPLOAD_BYTES`, default 5 MiB             |
| Pages per document                            | 100                                                    |
| Pages per account per UTC day                 | 500, including outstanding older reservations          |
| Queued jobs per account / globally            | 3 / 6                                                  |
| Running jobs per account / globally           | 1 / 2                                                  |
| Attempt deadline / stored result bound        | 60 seconds / 10 MiB                                    |
| OCR category commitment                       | $10/day and $100/calendar month                        |
| Shared model + OCR ceiling                    | Disabled at $0/day and $0/month by default             |

Set explicit `GLOBAL_DAILY_SPEND_LIMIT` and `GLOBAL_MONTHLY_SPEND_LIMIT` values for
any paid work. `OCR_DAILY_SPEND_LIMIT` and `OCR_MONTHLY_SPEND_LIMIT` are additional
category caps, not extra funds. Optional model category caps and the existing
per-user model budget remain independent of OCR page entitlements. Parsing credits
do not purchase model reasoning or storage. Limits apply on the server.

## Admission and execution

1. Authorize an owned immutable PDF asset. Validate its stored length and digest,
   and count its pages locally in the bounded PDF worker. Client page counts and
   credit balances are never accepted.
2. Quote required page credits with a hash of the complete provider/model/version,
   options, and verified price. Submission must accept this exact policy hash.
3. In one IMMEDIATE transaction, recheck ownership, duplicate receipts, available
   page credits, daily pages, queue capacity, and shared/category monetary budgets.
   Persist the spend reservation, held pages, job, and request receipt together.
4. Deduplicate by owner + original byte digest + complete extraction policy. New
   request keys, repeated requests, and process restarts cannot create a second
   job for that identity. Cross-account ownership remains isolated.
5. `runNext()` atomically claims one eligible job and persists its attempt and
   deadline before preparing bytes and invoking the provider. It checks reduced
   operator budgets before claiming already-reserved work. Queued jobs with old
   policies wait for a matching executor or can be cancelled.
6. Confirmed success persists the provider result and settles costs/credits using
   the frozen price and confirmed billed pages. The result survives restart and
   can be read without another provider call. Oversized/invalid responses are
   uncertain, not free.
7. Cancellation is allowed only while queued. A known preparation failure before
   dispatch releases spend and held pages. Timeout, provider failure, lost process,
   or invalid billing after dispatch retains both liabilities. Late responses
   cannot overwrite a recovered attempt. Expired running jobs become uncertain;
   queued jobs remain eligible. No dispatched job is automatically retried.

A repeated request for a failed/cancelled/uncertain identity returns that terminal
job. This first admission release intentionally provides no paid reparse/retry
endpoint. A future explicit reparse action must show and reserve its additional
cost; it must not silently turn a repeated delivery into another paid attempt.

All unresolved monetary reservations count against later days and months. Page
credits likewise remain held until billing is reconciled. This is conservative:
a crash during preparation can require reconciliation even if no charge occurred.

## API

All endpoints use existing session authorization, request throttling, origin
checks, body bounds, and read-only/storage maintenance controls. Granting credits
is never exposed through this API.

- `GET /api/ocr/credits`: enabled state and granted/committed/available pages.
- `POST /api/assets/:id/ocr/quote`: policy ID, pages, required credits, existing job.
- `POST /api/assets/:id/ocr`: `{ "key": "durable-client-key", "policyId": "quote-hash" }`.
- `GET /api/ocr/jobs/:id`: owned job state and credit commitment.
- `GET /api/ocr/jobs/:id/result`: persisted provider result, or null if unavailable.
- `POST /api/ocr/jobs/:id/cancel`: release a queued job before dispatch.

Insufficient credits returns 402. Page/queue/spend exhaustion returns 429. A policy
or request identity conflict returns 409. Unauthorized resources return 404.
No public response exposes another actor's cache or grants.

## Operator commands

Inspect credits:

```sh
node --import tsx --env-file-if-exists=.env scripts/ocr-credits.ts --actor USER_UUID
```

Invite one account to the 50-page trial:

```sh
node --import tsx --env-file-if-exists=.env scripts/ocr-credits.ts --actor USER_UUID --receipt INVITATION_ID --kind trial --pages 50 --evidence "operator invitation reference"
```

After verifying a real prepaid payment, grant its purchased pages:

```sh
node --import tsx --env-file-if-exists=.env scripts/ocr-credits.ts --actor USER_UUID --receipt PAYMENT_RECEIPT_ID --kind prepaid --pages 500 --evidence "verified payment reference"
```

Receipt IDs must identify the original payment, not a generated ID per retry.
Replaying an identical grant is idempotent; changing its account, amount, or
evidence conflicts. Trial grants also have a unique account constraint. Grants
cannot be edited or deleted, and deleting/reuploading a document cannot reset usage.
Do not put card details or secrets in evidence.

After verifying uncertain provider billing:

```sh
node --import tsx --env-file-if-exists=.env scripts/reconcile-ocr.ts --job JOB_UUID --pages CONFIRMED_BILLED_PAGES --evidence "provider request or invoice reference"
```

This transaction settles the spend ledger and held credits with immutable evidence.
Zero releases the held credit amount only when the provider confirms no charge.
Reconciliation does not fabricate a missing extraction result. Model reconciliation
continues through `scripts/reconcile-cost.ts` and cannot reconcile OCR commitments.

## Provider and checkout integration follow-up

Implement a pinned-price `OcrProvider` with transport retries disabled, bounded
response reads, confirmed billed-page validation, and abort propagation. Schedule
`runNext()` with the app's disk/read-only/shutdown gates and call recovery during
startup. No environment flag alone can currently enable a paid provider.

Keep the provider response as evidence, then normalize it into a page/block
representation for context selection and source highlights. The admission result
is not yet substituted into artifact model context.

Add an explicit page-credit confirmation in the PDF UI and a verified payment
webhook that invokes the operator grant boundary with the canonical receipt ID.
The proposed $5/500-page pack is a product decision, not configured billing. Keep
automatic refill off. Validate the provider and payment sandbox end to end before
opening paid parsing to accounts.
