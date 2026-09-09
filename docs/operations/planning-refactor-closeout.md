# Run planning and execution refactor closeout

## Completed boundaries

This sequence established workspace lifecycle ownership and durable submission
receipts, validated persistence/API boundaries, transactional run/attempt/accounting
transitions, exact microdollar arithmetic, shared preview/submission planning, and
batched context reads. The last round removes per-reference planning queries and
shares representation hydration across local context and conversation lineage.

Tests exercise stale leases, rollback, uncertain billing, immutable price snapshots,
preview/reservation parity, actor isolation, duplicate-reference ordering, and bounded
query growth. Existing browser scenarios continue to cover the complete workspace
flows. Mock/local verification does not establish live-provider reasoning quality or
host-specific operational readiness.

## Natural stopping points

**Stop this architectural sequence after the batch-reader round.** The identified
problems now have explicit owners and observable contracts. Remaining casts elsewhere
in the repository, file sizes, or another possible abstraction do not by themselves
justify extending the project. Greenfield freedom makes justified changes easier;
it does not make speculative infrastructure valuable.

**Stop performance work at the measured boundary.** Planning image references uses
two reader queries at 1, 32, and 200 blocks. Combined lineage and local inputs share
one representation query. More content still means more bytes, parsing, and model
context. Reopen optimization when a representative workload misses an explicit
latency, memory, or payload budget; query counts alone do not establish those budgets.

**Keep capability expansions separate.** Multiplayer, multiple worker servers,
semantic retrieval, and automatic workflow execution change product invariants.
They deserve a concrete use case and a separate decision, rather than emerging as
follow-on cleanup. The existing non-goals remain in force.

## Recommended next pivot: bounded product-quality evaluation

Prepare a small repeatable corpus around three existing workflows:

1. Develop a rough note into a useful next artifact with Spawn.
2. Synthesize a PDF and image with explicit ordered context.
3. Continue a branch after editing its original reference, checking that the old
   branch keeps frozen evidence and the new request uses the intended current draft.

Use three cases per workflow, with expected context/provenance, a description of a
useful answer, and an explicit failure condition. Record context fidelity, factual
support, usefulness, required manual revision, latency, and cost. Keep the corpus
and results reproducible. Choose a model and spending cap before any paid trial;
mock runs can evaluate mechanics but cannot score reasoning usefulness.

Stop the evaluation when all nine cases have been reviewed and one highest-impact
product problem has been selected. That problem becomes the next focused project;
there is no default second architecture audit.

## Conditional alternatives

If operating a deployed instance is the immediate objective, choose a target host
and storage configuration, then rehearse backup/restore, interruption, and billing
reconciliation there. Stop at a recorded restoration and recovery result, fixing
only failures observed in that drill.

If representative use reveals slowness first, profile that exact corpus and select
a latency/memory budget before changing storage or caching. Resume structural work
only for a reproduced correctness failure, a breached measured budget, or a newly
approved capability that needs a different invariant.

## Validation

`npm run verify` passed formatting, TypeScript, production builds, 326 unit and
integration tests across 45 files, and 21 Chromium browser scenarios. The batch-reader
coverage includes 200 distinct images, 64 draft edits, combined lineage/local
hydration, repeated-reference ordering, foreign/missing identities, malformed live
state, and request isolation. No live provider or deployment trial was part of this round.
