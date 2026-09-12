# Enhanced PDF parsing: admission and page credits

## Current boundary

The upload → page-credit confirmation → durable execution → page preview → explicit
context adoption flow is implemented. The provider is pinned to Mistral OCR 4.1
(`mistral-ocr-4-1`) at $4/1,000 synchronous pages, verified on 2026-09-11 from the
[official model and pricing page](https://docs.mistral.ai/models/ocr-4-1).
Production remains disabled by default (`OCR_PROVIDER=disabled`) and requires an
explicit provider selection, server credential, positive shared/category budgets,
and operator-granted page credits before dispatch. No paid provider call was made
while implementing or verifying this flow. There is no payment processor, public
checkout, or automatic refill. Operator grant commands support an invited pilot
and manually verified prepaid receipts; they do not collect or verify a payment.

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
- `GET /api/assets/:id/ocr`: enabled state, current policy identity, credits, and the
  latest owned job, including saved results while new processing is disabled.
- `POST /api/assets/:id/ocr/quote`: policy ID, pages, required credits, existing job.
- `POST /api/assets/:id/ocr`: `{ "key": "durable-client-key", "policyId": "quote-hash" }`.
- `GET /api/ocr/jobs/:id`: owned job state and credit commitment.
- `GET /api/ocr/jobs/:id/result`: persisted provider result, or null if unavailable.
- `POST /api/ocr/jobs/:id/cancel`: release a queued job before dispatch.
- `POST /api/ocr/jobs/:id/apply`: `{ "blockId": "PDF_BLOCK_UUID", "version": 0 }`.
  Adopt verified text into that owned PDF block; reject another document or stale
  version. Repeating an already applied job returns its current version without
  another edit or charge. Existing immutable revisions and run inputs stay pinned.

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

## Provider and product boundary

The adapter uses one direct HTTPS request with retries and redirects disabled.
It sends original PDF bytes as a data URI with an explicit complete page range.
It requests native blocks without embedded images, annotations, batch processing,
or paid extras. Request options, normalization limits and the exact model/price
are part of the policy hash. The response must identify the exact model, contain
all pages in order, and confirm the same page count through
`usage_info.pages_processed`. Incomplete billing, invalid blocks, malformed JSON,
stream errors, timeout and oversized results retain uncertain liabilities.

Response bytes are read incrementally under a 10 MiB bound; normalized output plus
unaltered provider evidence must also fit that bound. Normalization preserves
page Markdown, dimensions, native block text and unit-coordinate bounds in
`ocr-pages-v1`. Each page is limited to 20,000 characters and 2,000 blocks. The
result evidence becomes immutable on success. Terminal jobs cannot be reset to
queued. No external URLs from provider output are fetched or rendered as HTML.

`OcrWorker` recovers expired attempts and claims work under the application's disk
and read-only gates. Shutdown aborts active transports; dispatched work becomes
uncertain while known preparation failures release credits and spend. A disabled
provider still permits recovery and reading/applying previously saved output.

Open **Enhanced PDF extraction** on an imported PDF. Review verified pages and
available credits before confirming transfer to Mistral and a reservation. Merely
uploading, viewing, quoting, refreshing or reopening the panel cannot dispatch
paid work. A deterministic client key and server content/policy identity recover
lost acknowledgements and reloads. Historical jobs expose their parser identity;
quoting a newer parser explicitly shows a separate credit reservation. Cancelled
and failed identities remain terminal in this bounded release.

Preview enhanced pages, then choose **Use enhanced text for model context** to
adopt the result into that PDF's immutable representation. Future snapshots use
the enhanced text; earlier snapshots remain unchanged. Other open tabs refresh
through the existing replica broadcast. Normal context character and monetary
admission limits still apply to expanded PDF text. Native block coordinates are
retained for later source-highlighting UI; page Markdown is the current preview.

## Activation and next verification

1. Keep `OCR_PROVIDER=disabled` until an operator deliberately authorizes a small
   live provider check. Reverify the pinned model, contract and price first.
2. Supply `MISTRAL_API_KEY`, select `OCR_PROVIDER=mistral`, and set explicit shared
   and OCR daily/monthly ceilings. `npm run check:production` checks this structure
   without disclosing credentials or calling the provider.
3. Grant the invited account its one 50-page trial. On an isolated pilot instance,
   authorize one known one-page PDF, confirm the page-credit prompt, compare the
   retained response to the provider usage record, and verify the $0.004 charge.
4. Turn processing off again and verify the stored result still previews/applies.
   Exercise manual reconciliation only with real provider billing evidence before
   expanding the pilot. A checkout/payment integration is separate future scope.

Local verification uses the real HTTP/auth/upload/admission/worker/provider
adapter and context paths with an explicitly blocked external network fixture.
Adapter contract tests cover billing/model/page mismatches, native block bounds,
byte limits, transport failure and abort. Service tests cover budget/credit races,
shutdown/restart, adoption/version conflicts, frozen revisions and immutable
evidence. The browser test covers consent, insufficient credits, cancel-before-
confirmation, reload recovery, cross-tab adoption, future model inputs and an
uncertain provider outcome. These checks do not verify live Mistral credentials,
actual recognition accuracy or invoiced charges.
