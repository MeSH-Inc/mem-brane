# Interruption and conflict checkpoint — 2026-09-08

This round completes the local interruption/conflict drill recommended by the
[product workflow checkpoint](product-workflow-checkpoint.md).

## Findings and changes

The old recovery key was actor plus block ID. Two tabs therefore overwrote the
same IndexedDB record, and one tab's successful save could delete the other tab's
only recovery copy. Each editing session now owns a unique draft record. New
edits retain both the base version and base text. Clearing a saved edit deletes
only its own record.

Reload lists the actor's saved drafts instead of choosing one automatically. The
workspace shows how many other drafts are available. **Recover a copy** creates a
new editing record and preserves the source, since another tab may still own it.
The recovery action itself does not save or submit anything. Refresh saved drafts
retrieves newer entries from other tabs. A normal save acknowledgement cannot
clear a different recovery copy selected while that save was in flight.

A stale Spawn rejection now refreshes the workspace immediately so its conflict
controls appear. The comparison shows full original text and version, local text,
and current server text and version. The user explicitly chooses server text or
overwrite; overwrite remains subject to the server's version check. There is no
automatic merge.

Run and Spawn previously retained uncertain requests only in memory. They now
journal the exact request before transport, scoped by actor, brane and browser
tab. Reload restores the original idempotency key and request. A retry reconciles
that operation, independent of newer composer edits or attachment choices. Spawn
now treats HTTP 408 as uncertain, like Run already did. Definite rejection clears
the pending request so corrected intent can use a new key.

The journal validates recovered requests with the API schemas. Unreadable or
malformed journal data blocks submission visibly. A failed journal write prevents
transport; failure to clear an accepted request leaves it safely retryable with
the same key. Spawn acknowledgements only advance a draft based on the submitted
version, and never rebase it onto a newer unrelated server version.

## Rehearsals

- `e2e/draft-conflicts.browser.ts` interrupts text requests from two tabs, reloads
  both and verifies both copies. Saving A preserves B. B's stale Spawn creates no
  run, exposes three-way evidence, and succeeds only after explicit resolution.
- `e2e/submission-recovery.browser.ts` lets the server accept Run and then drops
  its response. After editing the prompt and reloading, retry sends the identical
  request, creates only one run, and keeps the new prompt. The Spawn variant
  substitutes HTTP 408 after acceptance, reloads, and retries the identical
  request. A newer local draft and concurrent server edit remain distinct and
  conflicted after reconciliation.
- The prior mixed-media rehearsal now waits for its fixture note's autosave before
  reloading. This reflects the deliberate change from implicit hydration to
  explicit selection of unsaved block drafts.

Network interruptions are deterministic browser request failures against isolated
built servers, disposable SQLite databases and local assets. These are not tests
of an actual network outage or a live provider. No paid provider or R2 calls were
made.

## Validation and commits

- `efb2565`: independent block draft records and three-way conflict evidence.
- `6301170`: persisted uncertain requests, safe acknowledgement handling and browser regressions.

`npm run verify` passed: formatting, TypeScript, production builds, 210 unit and
integration tests across 37 files, and 21 Chromium browser tests. Documentation
changes were separately format-checked. No push was performed.

## Boundaries and stopping point

Block draft copies remain in IndexedDB until their own editing record is saved or
cleared; originals retained by recovery are not automatically purged. The new
request journals, composer and title drafts have tab-session lifetime. Reload and
navigation are covered; closing a tab or clearing browser storage can discard
those session records. This is not a cross-device recovery system.

Stop this interruption/conflict round when the local verification passes. Both
drafts remain recoverable, conflicts expose their evidence, and uncertain retry
preserves the operation identity. No synchronization framework or data-layer
redesign is needed for these results.

## Recommended follow-up

Completed by the [refactor closeout](refactor-closeout.md), which records safe saved-copy removal and recommends stopping this refactor project. The original bounded follow-up was **saved-draft lifecycle controls**:

1. Make retained copies distinguishable by block, saved time and preview, and offer
   explicit removal of an unwanted copy. Compare the exact record being removed
   transactionally so a stale dialog cannot delete a newer write from another tab.
2. Exercise recover → edit → save → discard the original, including another tab
   updating that original during discard. Keep recovery non-destructive and avoid
   automatic age-based deletion.
3. Stop once users can intentionally retire old copies without risking active
   edits. Leave cross-session request recovery as a separate product decision;
   it needs a visible pending-operation list and explicit reconciliation semantics.

After that, prioritize using the three product workflows on a real project over
another architecture sweep. A live-provider quality trial remains a separate,
explicitly budgeted decision.
