# Live response generation

The September 30, 2026 configuration selects DeepSeek V4.1 Flash (`deepseek-flash`)
using the operator's existing DeepSeek account. `DEEPSEEK_API_KEY` is server-only;
it must never enter the repository, client bundle, or logs.

The native DeepSeek adapter streams Chat Completions with thinking disabled and no
automatic retries. Each response is bounded to 1,024 output tokens. Frozen text,
image bytes, and conversation inputs use the existing run queue and spend ledger.
Provider identity is recorded as `deepseek`, separately from OpenAI and mock runs.

Admission reserves at peak, uncached prices: $0.30 per million input tokens and
$1.20 per million output tokens, verified September 30 against
[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/).
The image bound is 1,024 tokens per image, per the
[vision documentation](https://api-docs.deepseek.com/guides/vision/).
The app conservatively accounts at these rates even during cheaper off-peak or
cached requests. Shared limits are $1/day and $5/month; the per-account limit is
$1/day. These limits govern this deployment, not other applications sharing the key.
OCR remains disabled.

Responses reveal themselves when submitted, unless the user has moved on. Both
Canvas and Focus render Markdown, preserve partial output, and provide Copy and
Stop or Try again on the response itself. Try again creates a new paid attempt
from the same frozen inputs. Continue opens the composer for a follow-up. Model
HTML and remote images are not rendered. A saved composer whose model has been
removed from the allowlist adopts the server default.

For validation, run the provider adapter and response component tests, the browser
submission/recovery flow, and the production build. After deployment, run
`scripts/live-smoke.ts` using the private smoke account and `SMOKE_MAX_USD=0.01`;
this exercises image context, persisted output, and the live spend ledger. Keep
credentials and smoke receipts in private operator storage.
