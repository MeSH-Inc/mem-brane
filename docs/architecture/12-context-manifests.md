# Frozen context manifests

A run references one immutable `context_manifests` identity. The manifest records
its owner and optional parent conversation message. `context_entries` contains
only the current request's ordered sources, references and final prompt. Inserting
the first run seals the manifest: the database rejects later entry insertion,
updates and deletion. Entries reference owned immutable revisions; the publishing
run must match the owner and conversation, have contiguous positions and exactly
one final prompt. Retries reuse the same manifest without copying its entries.

Each immutable conversation message records its originating Run ID. A user message
points to that run's prompt revision and manifest parent; an assistant message
points to the same run's user message and output-block revision. Database triggers
enforce those relationships. Message reference lists are projected from the
originating manifest, removing the former independent `context_json` authority.

The graph is append-only. A manifest may reference an already published message,
and a new message's parent is fixed by that manifest. Updates cannot introduce
cycles. Context reads walk the selected ancestor chain, bounded at 200 messages,
then expand each user message's source/reference entries before that message.
Ancestors become `lineage` inputs, their references become `lineage_reference`, and
the current request's local entries follow them. Order, labels, repeated references,
roles and exact revision identities are preserved. Continue from a user message
stops at that message; independent branches and derivation ancestors are not
implicitly included.

`RunInput` is now the expanded read contract, not a flattened storage table.
Worker execution, cost admission, estimates and inspection share the same context
expansion semantics. Finalization reads only the local prompt and parent identity.
Live edits and newer extraction results do not participate in expansion. The
conversation endpoint returns typed messages with parsed content and references.

Migration 014 builds manifests and associates existing messages with their
originating runs. It compares every reconstructed input sequence against the old
flattened rows and checks message reference JSON against the original local inputs
before removing either representation. Divergence aborts the transaction. Existing
run, revision, message and output identities survive. The legacy fixture covers
branching, continuation from user messages, images, multi-source derivation,
failed runs and retries; tests compare both expanded inputs and provider messages.

For the measured 80-turn fixture, storage falls from 6,480 flattened input rows to
81 local context entries. Expansion still produces 160 inputs for the last run.
This reduces historical storage growth, not the model's required context size or
token cost. Content limits and the lineage-depth boundary remain enforced.

## Preview and submission planning

`run-plan.ts` resolves a read-only plan shared by estimation and admission. It checks
model and context limits, validates draft versions and editability, resolves finalized
snapshot candidates, expands frozen lineage, and computes the output limit and cost
quote. Duplicate edits for one block are rejected. Webpage draft normalization and
snapshot readiness use the same functions as saving and snapshot creation.

Preview runs the planner in a read transaction and reports the current budget without
creating revisions, manifests, runs, or reservations. Submission replans inside its
write transaction, applies the validated edits, freezes the ordered local entries,
and stores the plan's quote. Preview is advisory: a later submission sees intervening
edits and budget changes. Queue/concurrency checks remain admission concerns.

Pending revision identifiers use a UUID-width placeholder solely when calculating
provider message bytes; committed context always contains actual revision identities.
Parity tests independently recalculate costs from committed inputs and compare them
with preview and reservation for Unicode drafts, output limits, webpages, images,
and conversation lineage. Invalid drafts, unfinished generated references, and
oversized context fail consistently in both paths.
