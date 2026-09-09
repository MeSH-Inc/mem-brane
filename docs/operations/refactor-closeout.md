# Data and recovery refactor closeout — 2026-09-08

## Latest round: retire saved copies safely

The saved-draft list now identifies each copy by block, timestamp, base version,
copy identifier and full text preview. **Remove saved copy** removes that precise
local snapshot; it does not change server content or another tab's editor text.
Recovery continues to create an independent copy.

Removal reads the current record, compares every stored field with the displayed
snapshot and deletes it in one IndexedDB read/write transaction. A newer value is
kept, the list refreshes, and the user is told to review it before another removal
attempt. An already removed copy is treated as complete. This does not depend on
wall-clock timestamps being unique. A failed removal leaves the record available
and does not break subsequent recovery reads or retries.

The interaction store rejects removal requests for another account or this tab's
active draft. An unchanged copy owned by another open tab can be explicitly
removed; the open editor retains its text, and subsequent edits can write a new
recovery snapshot. There is no automatic expiry or bulk purge.

The browser drill completes recover → edit/save → remove original, verifies the
server content and independent copies remain intact, then holds a stale list open
while the original's live owner edits again. Removal preserves the newer durable
copy and the owner's editor text, including after reload. Storage tests cover
changes to every payload field, equal timestamps, concurrent transactions,
missing records and storage failure. Store tests cover account and active-editor
boundaries.

## Validation

Implementation commit: `adce04b`.

`npm run verify` passed: formatting, TypeScript, production builds, 222 unit and
integration tests across 38 files, and 21 Chromium browser tests. The lifecycle
browser test was then strengthened to edit the recovered copy before saving and
removing its original; that targeted test also passed. Documentation was separately
format-checked. No push or paid provider/object-store calls were performed.

## Decision: stop this refactor project here

The original data-efficiency work has reached explicit boundaries: shared binary
assets and frozen representations, parent-linked context, bounded history reads,
batched request reads and verified cleanup reporting. The supporting results are
in the [data-layer checkpoint](data-layer-checkpoint.md).

The follow-on product rehearsals exposed concrete correctness gaps, rather than
just opportunities for cleaner code. Those gaps now have tested behavior:
independent block recovery, visible three-way conflict evidence, preserved
composer/title intent, exact uncertain-request retry and safe retirement of old
draft copies. See the [product workflow](product-workflow-checkpoint.md) and
[interruption/conflict](interruption-conflict-checkpoint.md) checkpoints.

This is a defensible stopping point because the identified failure modes now have
contracts, user controls and regression coverage. Another general sweep would
mostly optimize hypothetical future requirements. Do not automatically start
another schema redesign, synchronization system or draft framework.

The remaining boundaries are product choices: composer/title drafts and retry
journals last for a tab session, authored history has no automatic expiry, and live
provider/object-store behavior has not been established by mock/local tests.
Closed-tab operation recovery would require a visible pending-operation workflow;
it should not be added incidentally as a storage substitution.

Reopen architecture work when representative use violates a measured read/storage
boundary, reveals actual data loss or duplicate execution, or introduces a
specific new invariant. A larger abstraction by itself is not evidence.

## Recommended pivot: one bounded product-use evaluation

1. Choose one representative research or planning task with real notes, a PDF and
   images. Spend one 60–90 minute session completing it in the existing product.
   Cover capture, composition, branching, resuming an interrupted edit and checking
   the provenance of a conclusion. The mock model can assess mechanics; it cannot
   establish useful reasoning quality.
2. Record failed outcomes, unexpected context and manual recovery separately from
   cosmetic friction. Identify the single problem that most obstructs completing
   the task. Avoid building a feature list from speculative possibilities.
3. Fix that one problem with its regression case, then repeat the task once. Stop
   when it completes cleanly. If no consequential problem emerges, leave the code
   alone and collect another actual-use example.

A reasoning-quality evaluation is the alternative pivot: choose a provider and
representative tasks, explicitly authorize a fixed spend cap, then compare useful
outputs and frozen context. Operational readiness is another separate project,
triggered by choosing a deployment host and object store. Neither was performed
in this local refactor.
