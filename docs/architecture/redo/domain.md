# Domain mapping

The redo is mostly a new projection of records that already exist. It adds one block
kind, a host column on placements, three brane-scoped records and one manifest entry
kind, and changes one principle.

## Unchanged

| Redo object               | Existing record                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Card front                | Block + LiveState or finalized revision, placed by a Placement                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Receipt                   | Run, its sealed context manifest and RunOutput                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Developments              | Runs whose manifest has this block as a source or a reference entry                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Reply and its thread line | The manifest's parent conversation message, exactly as Continue records it today; the line is projected from ConversationMessage parents                                                                                                                                                                                                                                                                                                                                                   |
| Output on a back          | A placement whose `host_placement_id` names the table placement holding it                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Put on table              | `placement.detach`: clear the host and give the placement table geometry                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Each and Compare models   | Several Runs admitted in one transaction with one combined reservation. Every input is known at admission (a stack's members, a list of models), so every Run freezes its own manifest at the press. _Each is implemented in iteration 9: the runs share a batch (`run_batches`: batch, position) and count once against the run limits. Compare models in iteration 11: the same batch, one run per model, all freezing the same inputs; Keep puts the others on the kept answer's back._ |

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
Workshop items are saved prompts (`workshop_machines`: name and template, owned by the
account), beside five built-in ones; taking one out places a new machine block with a
copy of the prompt.

**Outputs of several cards** (table `run_parts`, migration 008). A prompt whose last
line is `Output: cards` or `Output: diagram` declares that its answer is placed as one
card per numbered item; the declaration is read from the frozen prompt revision, so
the prompt stays the only authority over a machine's inputs and its output's shape.
The run's output is still one block holding the whole answer. On completion, in the
completion's transaction, the server adds one generated block per item, each with one
revision (the item's text) and a `run_parts` row (run, position, block, revision),
places them where the output lay and puts the whole answer on the first card's back.
Each part is an output of the run: the workspace read lists the parts (`parts`), and
derivations carry a row per part and frozen input, so backs, staleness and Update work
for a part as for the answer. A diagram's relation lines (`2 —supports→ 1`) become
arrows between the parts. _(Implemented in iteration 10.)_

_Decision (iteration 10): the server splits the answer at completion, not the model
call nor the client._ The split must happen once, survive a closed tab, and be part of
the run's record; the worker's completion is the one moment that holds the full text
inside a transaction.

_Decision (iteration 9): a Workshop item is a stored prompt, not an unplaced machine
block._ An item is only ever copied, so it needs no live state, revisions or
placement; as a block it would also have appeared among Unplaced cards.

**The slot is the entry label.** A machine run's references are labelled with the slot
they filled, and its prompt entry is the machine's own frozen revision. The existing
`label` column carries the slot, so manifests need no new column; the receipt and the
response's **Based on** strip show slot names instead of ordinals. _(Implemented in
iteration 3.)_

**Manifest entry kind `relation`.** It states how two inputs of the same run stand to
each other, as frozen text that names them by entry label ("Reference 2 answers
Reference 1."), adding the frozen revision when two inputs share a label. The text is
an unplaced revision, like an Ask's prompt, so the entry is as sealed and owned as any
other. Relation entries come after the inputs and before the prompt, and only arrows
whose two ends are both inputs of the run are sent. Its structure (the positions of
the two entries it joins, and the word) is sealed beside it in `relation_entries`, so
a workspace can read which arrows a run sent by block. _(Implemented in iteration 7;
structure in iteration 8.)_

**Feed** (brane-scoped): exactly one of `from_placement_id` or `from_group_id`;
`to_placement_id` (a machine); `slot`; `position` within the slot; `mode`
(`together` | `each`). A feed is semantics, not presentation, so it is synchronized
like a placement, through the offline outbox as `feed.create` and `feed.remove`. Feeds
are immutable: changing one is a removal and a creation. A run never reads feeds: the
client sends the machine's inputs explicitly, the server checks them against the
template it freezes, and later feed edits affect only later runs. A feed that would
close a loop through trays is rejected on write.

_Iteration 3 implements_ `from_placement_id`, `to_placement_id` and `slot`, with
position given by creation order; _iteration 8_ adds `from_group_id` (migration 006),
and _iteration 9_ adds `mode` (migration 007), which only a group feed may set to
`each` and which is the only part of a feed that may change (`feed.mode`). At most one
slot of a machine is fed `each`. A machine cannot feed a machine yet, so no loop is
possible and no cycle check exists.

**Arrow** (brane-scoped, table `relations`): `from_placement_id`, `to_placement_id`,
`label` (required, 1 to 60 characters). Both ends are cards on the table; removing
either removes the arrow, and a rerun or Update moves the arrows of the card it
replaces onto the new one. Arrows are synchronized like feeds, as `relation.create`,
`relation.relabel` and `relation.remove`. An arrow never causes a run. It is read only
when both ends are inputs to one run. _(Implemented in iteration 7; relabel in
iteration 8.)_

**Group** (brane-scoped, tables `groups` and `group_members`): a label (1 to 60
characters), a display (`region` | `stack` | `matrix`), and an ordered list of member card
placements on the table. A card belongs to at most one group; a group whose last member
is removed is removed with its feeds, and a rerun or Update puts its new output in the
replaced card's place in its group. Groups are synchronized as `group.create`,
`group.edit` (the whole group: label, display and members) and `group.remove`. Display
is presentation: a region frames the cards where they lie, a stack piles them into the
first member's space. A feed from a group expands, when the machine is run, to its
members in member order, which is reading order at the time each card joined.
A matrix is computed, not stored beyond its display: a member's column is the machine
whose run produced it and its row is the card that run ran over (the input no other run
of its batch sent); the client lays the cells out and the frame draws the headings.
_(Implemented in iteration 8; `matrix` in iteration 10.)_

**Loose Ask.** `/` creates a machine block and placement. After the run, the machine's
placement is removed and the output takes its position; the machine block stays,
unplaced, so **Update** and **Make reusable** can reach it.

## Staleness is a projection

A machine is stale when what its lever would send now differs from what its last run
froze: per slot, the fed blocks (a fed group's current members included) and their
live versions, the arrows between the fed cards, and the machine's template version.
For a press that ran each, what the last press froze is every run of its batch in
position order, so a card added to the fed stack, or a change of mode, is a change.
An asked answer is stale when a source's version or the arrows between its sources
differ. Each workspace run carries `machine_block_id` and `machine_version`, each
derivation its slot `label` and the source's `sourceVersion`, so the client computes
staleness from the brane state it already holds, including unsaved and offline edits.
Nothing is stored for staleness. The Update estimate is a separate read-only
`/machines/estimate` call through `run-plan.ts`.

_Decision (iteration 3): staleness is computed on the client, not by re-planning on the
server._ The client's projection works offline and updates on every local edit; a
server re-plan per visible machine would need a request per edit. Iteration 8 adds
group membership and arrows to the same comparison: the workspace read carries each
visible run's sent arrows as `relationEntries` (run, from block, to block, word).

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
