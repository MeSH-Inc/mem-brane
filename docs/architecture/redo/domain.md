# Domain mapping

The redo is mostly a new projection of records that already exist. It adds one block
kind, three brane-scoped records and one manifest entry kind, and changes one
principle.

## Unchanged

| Redo object               | Existing record                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card front                | Block + LiveState or finalized revision, placed by a Placement                                                                                                                                       |
| Receipt                   | Run, its sealed context manifest and RunOutput                                                                                                                                                       |
| Developments              | Runs whose manifest has this block as a source or a reference entry                                                                                                                                  |
| Reply and its thread line | The manifest's parent conversation message, exactly as Continue records it today; the line is projected from ConversationMessage parents                                                             |
| Output on a back          | A generated block with no placement on this brane, listed through its run's inputs                                                                                                                   |
| Put on table              | Create a placement for that block (today's **Show here**)                                                                                                                                            |
| Each and Compare models   | Several Runs admitted in one transaction with one combined reservation. Every input is known at admission (a stack's members, a list of models), so every Run freezes its own manifest at the press. |

Develop stops creating a placement for its output. **Add → Unplaced cards** excludes
generated blocks that have a source or reference block still placed on the brane:
they live on that block's back.

## Added

**Block kind `machine`.** Content is the prompt template. It is authored, versioned
with LiveState and revisions, and placed like text. Slots are derived from the
template on save. A run freezes the machine's revision as the manifest's prompt
entry, and the worker substitutes frozen slot contents into the frozen template.
Workshop items are machine blocks owned by the account with no placement; taking one
out copies the block.

**Manifest entries gain `slot`.** Each source and reference entry records the slot it
filled, replacing today's `context N` labels on the receipt.

**Manifest entry kind `relation`.** It names two entry positions in the same manifest
and a label. The label is stored in the sealed manifest itself, which is immutable, so
a relation needs no revision of its own. Relations are included only between entries
of the same run.

**Feed** (brane-scoped): exactly one of `from_placement_id` or `from_group_id`;
`to_placement_id` (a machine); `slot`; `position` within the slot; `mode`
(`together` | `each`). A feed is semantics, not presentation, so it is synchronized
and versioned like a placement. A Run freezes what its feeds resolve to; later feed
edits affect only later runs. A feed that would close a loop through trays is
rejected on write.

**Arrow** (brane-scoped): `from_placement_id`, `to_placement_id`, optional `label`.
An arrow never causes a run. It is read only when both ends are inputs to one run.

**Group** (brane-scoped): an ordered set of card placements, a label, and a display
(`region` | `stack` | `matrix`). Display is presentation. A feed from a group
expands, at run time, to its members in reading order.

**Loose Ask.** `/` creates a machine block and placement. After the run, the machine's
placement is removed and the output takes its position; the machine block stays,
unplaced, so **Update** and **Make reusable** can reach it.

## Staleness is a re-plan

A machine is stale when planning its run now would produce a different manifest
than its last run sealed: other revisions, other group members, other relations, or a
different machine revision. `run-plan.ts` already produces this plan for estimates,
so staleness and the Update estimate come from one read-only planning call. Nothing
is stored for staleness.

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
