# Domain mapping

The redo is mostly a new projection of records that already exist. It adds one block
kind, a host column on placements, three brane-scoped records and one manifest entry
kind, and changes one principle.

## Unchanged

| Redo object               | Existing record                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card front                | Block + LiveState or finalized revision, placed by a Placement                                                                                                                                       |
| Receipt                   | Run, its sealed context manifest and RunOutput                                                                                                                                                       |
| Developments              | Runs whose manifest has this block as a source or a reference entry                                                                                                                                  |
| Reply and its thread line | The manifest's parent conversation message, exactly as Continue records it today; the line is projected from ConversationMessage parents                                                             |
| Output on a back          | A placement whose `host_placement_id` names the table placement holding it                                                                                                                           |
| Put on table              | `placement.detach`: clear the host and give the placement table geometry                                                                                                                             |
| Each and Compare models   | Several Runs admitted in one transaction with one combined reservation. Every input is known at admission (a stack's members, a list of models), so every Run freezes its own manifest at the press. |

Develop places its output on the source placement's back, and a machine run moves the
output it replaces, with that output's back, onto the new output's back. Backs are one
level deep: a host is always on the table, and removing it removes what it holds.

_Decision (iteration 4): an output on a back keeps a placement._ The concept first
left such outputs unplaced and listed them through their runs. Every read of a brane
(its blocks, runs, derivations and live updates) is scoped by placement, so an
unplaced output would have needed a second visibility rule in each. A host column on
the placement keeps one rule, and Unplaced cards needs no exclusion.

## Added

**Block kind `machine`.** Content is the prompt template. It is authored, versioned
with LiveState and revisions, and placed like text. Slots are derived from the
template on save. A run freezes the machine's revision as the manifest's prompt
entry, and the worker substitutes frozen slot contents into the frozen template.
Workshop items are machine blocks owned by the account with no placement; taking one
out copies the block.

**The slot is the entry label.** A machine run's references are labelled with the slot
they filled, and its prompt entry is the machine's own frozen revision. The existing
`label` column carries the slot, so manifests need no new column; the receipt and the
response's **Based on** strip show slot names instead of ordinals. _(Implemented in
iteration 3.)_

**Manifest entry kind `relation`.** It names two entry positions in the same manifest
and a label. The label is stored in the sealed manifest itself, which is immutable, so
a relation needs no revision of its own. Relations are included only between entries
of the same run.

**Feed** (brane-scoped): exactly one of `from_placement_id` or `from_group_id`;
`to_placement_id` (a machine); `slot`; `position` within the slot; `mode`
(`together` | `each`). A feed is semantics, not presentation, so it is synchronized
like a placement, through the offline outbox as `feed.create` and `feed.remove`. Feeds
are immutable: changing one is a removal and a creation. A run never reads feeds: the
client sends the machine's inputs explicitly, the server checks them against the
template it freezes, and later feed edits affect only later runs. A feed that would
close a loop through trays is rejected on write.

_Iteration 3 implements_ `from_placement_id`, `to_placement_id` and `slot`, with
position given by creation order. A machine cannot feed a machine yet, so no loop is
possible and no cycle check exists. Groups and `mode` are not implemented.

**Arrow** (brane-scoped): `from_placement_id`, `to_placement_id`, optional `label`.
An arrow never causes a run. It is read only when both ends are inputs to one run.

**Group** (brane-scoped): an ordered set of card placements, a label, and a display
(`region` | `stack` | `matrix`). Display is presentation. A feed from a group
expands, at run time, to its members in reading order.

**Loose Ask.** `/` creates a machine block and placement. After the run, the machine's
placement is removed and the output takes its position; the machine block stays,
unplaced, so **Update** and **Make reusable** can reach it.

## Staleness is a projection

A machine is stale when what its lever would send now differs from what its last run
froze: per slot, the fed blocks and their live versions, and the machine's template
version. Each workspace run carries `machine_block_id` and `machine_version`, each
derivation its slot `label` and the source's `sourceVersion`, so the client computes
staleness from the brane state it already holds, including unsaved and offline edits.
Nothing is stored for staleness. The Update estimate is a separate read-only
`/machines/estimate` call through `run-plan.ts`.

_Decision (iteration 3): staleness is computed on the client, not by re-planning on the
server._ The client's projection works offline and updates on every local edit; a
server re-plan per visible machine would need a request per edit. Group membership
and relations will join the same comparison when groups exist.

## Principle changes

| Current text                                                   | Replacement                                                                                                                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This is a spatial thinking interface, not a workflow engine." | "This is a spatial thinking interface with machines. Feeds declare a machine's inputs; one press runs one machine."                                                                          |
| "Connecting, grouping or proximity never executes anything."   | Unchanged; it now covers feeds, arrows and groups by name.                                                                                                                                   |
| Non-goals: general DAG semantics                               | Narrowed: feeds form an acyclic graph that is drawn and checked but never executed as a whole. Workflow execution, automatic downstream execution and automatic regeneration stay non-goals. |

The invariant that Continue and Use as context are different relationships stays
exactly as it is: Reply is Continue, a feed is Use as context.

## Cut from the current design

- **Composer context state and the ordering dialog.** Feeds and slot positions order inputs.
- **Projected derivation connectors.** Replaced by feeds, source lines and thread lines.
- **run_placements anchors for composed runs.** Outputs anchor to the tray, the Ask's
  position, or the source's back.
- **The Canvas/Focus switch on desktop.** Focus is a state of one card.
