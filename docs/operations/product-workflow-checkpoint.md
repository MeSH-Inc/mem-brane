# Product workflow checkpoint — 2026-09-08

This completes the bounded product/reliability round recommended by the
[data-layer checkpoint](data-layer-checkpoint.md). The implementation is commit
`98b511d`. No live model or R2 account was exercised.

## Rehearsal and findings

The built application runs against a disposable SQLite database and local asset
directory with the deterministic mock model. The browser rehearsal creates field
notes about flooded trails, a two-page PDF survey and a labeled PNG trail map.
The database and assets are removed after the test.

| Path                                 | Verified result                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture → Spawn                      | Spawn freezes the saved note and excludes the unrelated global composer prompt.                                                                                                 |
| Explicit references → compose        | Note, PDF and image references retain their order across reload; the submitted inputs contain those formats in that order. Accepted submission clears the prompt across reload. |
| Branch → provenance → older revision | Continuation survives reload, the branch runs, its frozen inputs are visible, and the original note snapshot reopens after editing the live note.                               |

The two most consequential recovery gaps were composer intent loss and unsaved
title loss. Composer prompt/model lived in route state, while references and
continuation were reset on entry. Title drafts also lived in route state; a save
acknowledgement unconditionally cleared them, including edits made during that
request. The rehearsal revealed no larger workflow blocker after these fixes.

The executable rehearsal is `e2e/workspace-recovery.browser.ts`. It also exercises
another brane, two independent browser tabs and a delayed title PATCH. During test
development, two selectors needed tightening: snapshot previews also appear in
the block outline, and the run inspector lists the newest run first. These were
rehearsal locator corrections, not additional product defects.

## Recovery contract

- Composer prompt, model, ordered references, continuation and unsaved title are
  stored together in sessionStorage, scoped by authenticated actor and brane.
- Writes occur with edits rather than relying on unload handlers. Navigation and
  reload restore intent. Each browser tab evolves independently; a duplicated tab
  may start with the browser's copied sessionStorage, then diverges independently.
- Actor/brane changes remount the workspace so local state cannot leak between
  identities. Storage payload validation rejects malformed context. Storage errors
  leave edits in memory and display an error.
- Title acknowledgement clears only the title actually saved. A newer title stays
  visible and recoverable. Unsaved titles have a visible label.
- Recovery does not freeze referenced content early. The UI states that current
  reference content is frozen at Run; the selected continuation still identifies
  its existing conversation branch. Restoring a draft never submits it.

This is tab-session recovery, not a cross-session draft library. Closing a tab or
clearing browser storage can discard composer/title drafts. Block text retains its
separate IndexedDB recovery mechanism; simultaneous unsaved edits to the same
block do not yet have separate per-tab durable identities. This round makes no
claim about automatic merging or live provider reasoning quality.

## Validation

`npm run verify` passed: formatting, TypeScript, production builds, 204 unit and
integration tests across 36 files, and 19 Chromium browser tests. The new unit tests
cover actor/brane isolation, ordered composer intent, acknowledgement field
clearing, storage failure and malformed recovery data. The new built-app rehearsal
covers actual sessionStorage reload and tab behavior.

## Stopping point and recommended follow-up

Stop the current architecture and workspace-recovery round here. All three paths
complete with explicit context and without manual data repair in the rehearsal.
More data-model redesign has no new evidence from this round.

The following drill is now completed by the [interruption/conflict checkpoint](interruption-conflict-checkpoint.md), which records the new explicit draft recovery and retry contract. The original recommendation was a **bounded interruption and conflict drill**:

1. Edit the same authored note in two tabs, interrupt a save with an offline
   transition, resume, and attempt Spawn after another tab changes the server
   version. Record exactly which local text, base revision and server text remain
   available at each decision.
2. If one unsaved draft can replace another in IndexedDB, give block drafts
   independent tab identities and explicit recovery selection. Add a three-way
   comparison only where the current overwrite decision lacks enough evidence.
3. Verify that rejected/uncertain submissions retain intent and never silently
   duplicate a run on retry. Stop when both drafts remain recoverable and conflict
   resolution is explicit; avoid synchronization infrastructure.

Alternatively, pivot to reasoning quality with a separately authorized, fixed-cap
live-provider trial using the same three tasks. Compare useful outputs and frozen
context accuracy. Choose operational readiness instead only when a target host
and object store are selected, then perform an isolated restore drill there.
