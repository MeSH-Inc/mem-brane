# Cost model

Initial recurring costs: one VPS for Node/SQLite/Caddy, object storage requests and bytes, model calls, off-host SQLite/asset backups and bandwidth. There is no Redis, vector database or paid sync service. Future collaboration infrastructure is optional and deferred.

Environment configuration controls global worker concurrency, per-user concurrent runs, max output tokens, max imported webpage bytes, max upload bytes, daily per-user model-spend limit, checkpoint interval and character threshold, model allowlist and default. Values are validated at startup and documented in .env.example. No paid call occurs without explicit Run intent; local default is deterministic mock. Confirmed provider usage is stored separately from estimates. Paid runs fail closed without operator-verified pricing and a positive daily budget. A per-Run ledger reserves conservative UTF-8/message/image token bounds plus the output cap, then settles using confirmed usage and frozen pricing. Uncertain billing retains the reservation across UTC day boundaries; explicit retries need separate reservations. Zero daily budget disables paid runs. Usage-rated cost is not an invoice; caching discounts and pricing tiers can make it conservative.

Keep backup retention and storage lifecycle bounded. Do not micro-optimize ordinary HTTP at the expense of context correctness or accidental paid calls.

Pricing entries include input/output USD per million tokens, vision support, a conservative low-detail image token bound, source URL and verification date. No live prices are invented or bundled. Reservations and prices are immutable; final billing state is mutable. Operator reconciliation records provider evidence in an immutable audit record.
