# Data-layer checkpoint — September 8, 2026

This round completes the recommendations from [asset read efficiency](asset-read-efficiency.md):

- `3417803`: request-scoped batching of representation and context-reference reads.
- `bf1b710`: revision-history summaries and selected-revision body loading.
- `8a9d3d3`: explicit cleanup liabilities in backup and restoration reports.

Full `npm run verify` passed formatting, type checking, production builds, **201
tests** and **18 browser tests**. Work was committed on `main`. No live provider,
remote object store, live database migration or push was involved.

## Evidence

The [read-boundary probe](read-boundaries.json) uses 200 distinct artifacts sharing
one real PDF representation. It separately exercises inherited-reference expansion
and 101 revisions of one artifact:

| Read                        | SQL statements | Representation queries | Other result                |
| --------------------------- | -------------: | ---------------------: | --------------------------- |
| 200-artifact workspace      |              8 |                      1 | 147,277 JSON bytes          |
| 200 inherited references    |              2 |                      1 | Identical provider messages |
| First 25 revision summaries |              2 |                      0 | 4,114 JSON bytes            |

The equivalent expanded revision page is 187,739 bytes. The summary page is about
97.8% smaller for this fixture. Provider content still expands from the exact frozen
revision. Within a request, shared representation payloads are decoded once and
reused; authorization is part of batch lookup. Context metadata is also fetched in
batches rather than one revision query per reference.

Revision previews are limited to 160 characters. Initial history rendering stores
summaries, and only the selected revision has a loaded body. Switching selection
clears that body and ignores stale responses. This bounds loaded history content;
no browser heap benchmark or universal latency improvement is claimed.

The 200-reference case stresses the reader independently of run admission and does
not imply such a PDF-heavy run fits configured context limits. Byte figures are
UTF-8 JSON measurements. The probe also verified all 500 content references.

```sh
NODE_ENV=test node --import tsx scripts/read-boundaries.ts /tmp/read-boundaries.json
```

## Backup report contract

Restoration verification now reports `cleanup.objects`, `cleanup.reservedBytes`,
`cleanup.requiredBackups` and a concrete `cleanup.nextAction`. Each required backup
entry contains its original fingerprint, object/byte counts, pending deletions and
unacknowledged deletions. These bytes are quota reservations, not a claim that the
redundant objects are physically present.

Bundle reports additionally declare `objectCoverage: canonical-assets-only`.
A restored bundle can therefore have valid canonical content and outstanding
cleanup reservations. The report identifies which original legacy backup is needed
to acknowledge deletion or absence. Verification remains read-only and never releases
quota or bypasses the verified-backup requirement. Tests cover both pending and
unacknowledged deletion states and clearing reservations after canonical-only restore.

## Good stopping points

**Stop data-efficiency refactoring here for the current single-server product.**
The expensive repetition identified during this sweep has explicit boundaries:
shared binary bytes, shared frozen representations, parent-linked context manifests,
batched reads, bounded history summaries and verified cleanup recovery. Another
schema pass has less evidence behind it than testing the product's actual workflows.

This is a local-development checkpoint, not a production-readiness claim. Live
provider and R2 behavior remain unverified according to the project README. Authored
history is still retained indefinitely under the documented disk-admission policy.
Those are deliberate scope boundaries to revisit when paid use or retention needs
become concrete.

Reopen this architecture work when a representative workload violates a measured
read boundary, retained history creates an actual storage problem, or a selected
product feature requires a new invariant. Multiplayer, distributed workers, vector
retrieval and general workflow engines remain deferred by the project's non-goals.

## Recommended pivot and bounded follow-up

My recommendation is a short **product workflow and reliability round**, with a
clear exit criterion rather than another open-ended architecture sweep:

1. Create one disposable workspace with realistic notes, a PDF and images. Rehearse
   three paths: capture → Spawn; combine explicit references → compose; branch →
   inspect provenance → reopen an older revision. Record the confusing steps and
   unnecessary actions. The mock provider can validate interaction and recovery,
   but it cannot validate reasoning quality.
2. Fix the two highest-impact workflow problems found. If the rehearsals reveal no
   larger problem, prioritize composer and title draft recovery: these currently
   live in route state while block drafts already have durable recovery. Preserve
   actor and brane identity across reload/navigation, and verify independent tabs
   cannot silently overwrite each other's unfinished drafts.
3. Stop once those three workflows can be completed without unexplained state loss,
   stale-context ambiguity or manual repair. Reassess with actual use before adding
   further infrastructure.

Two alternative pivots are also reasonable. For **reasoning quality**, authorize a
small live-provider trial with a fixed spend cap and representative tasks; compare
useful outputs and context provenance, not just successful API calls. For
**operational readiness**, validate the intended provider/object-store combination
and rehearse restore on the intended host before enabling paid use. These are
separate decisions and were not performed in this round.
