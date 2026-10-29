# Iterations

## Iteration 1: three nouns

Starting point: the current interface on an empty brane shows seven bands of chrome
before the first card (synchronization banner, title bar, hint row, card action row,
context row, composer, model and status line).

Proposal: one table holding cards with two faces, machines with slots and a tray, and
links that are feeds or arrows. Outputs on the back, a loose prompt in place of the
composer, region and stack groups, a **Run downstream** command over chains, a
per-machine output destination, a table output shape and a phone deck.

## Critique of iteration 1

An independent product-legibility review walked the scenarios as a new user and read
the domain mapping against the architecture documents. Its findings, most damaging
first:

1. Following up by feeding a response into a new prompt dropped the conversation and
   collapsed Continue into Use as context, which invariant 33 forbids.
2. **Run downstream** could not quote an honest estimate (Split's card count is
   unknown until it runs) and froze inputs after admission.
3. A slot took one card or one group, yet every scenario fed several cards.
4. Collapsing a region into a stack silently dropped its arrows from the next run:
   layout had become meaning.
5. Outputs went to two places under a per-machine setting, and every `/` left a
   machine on the table.
6. The main verbs were hover-only; touch had no way to draw a link; Save to Workshop
   was missing.
7. Shared machine instances let a prompt edit on one brane change another, and a
   prompt edit did not mark outputs stale.
8. Domain errors: a group was treated as a placement, the group digest had no run,
   developments ignored reference inputs, back-only outputs would flood Unplaced cards.
9. Concept cost: the table output shape, stored multi-model, a three-meaning amber pip.
10. Missing uses: a literature matrix, comparing versions, prompt revisions, quote to card.

## Iteration 2: decisions

| Finding | Decision                                                                                                                                                                                              | Rationale                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1       | `/` on a response is **Reply**, recorded as the manifest's parent message, drawn as a thread line that cannot be redrawn.                                                                             | Keeps Continue and Use as context structurally distinct, using the record that already exists. |
| 2       | **Update** reruns one machine; the next machine goes stale and offers its own Update.                                                                                                                 | Every estimate is exact and every freeze happens at the press.                                 |
| 3       | A slot takes any number of cards in feed order; a group feeds its members.                                                                                                                            | Matches how every scenario actually feeds.                                                     |
| 4       | Group display (region, stack, matrix) is presentation only; arrows are sent whenever both ends are inputs of one run.                                                                                 | "Spatial arrangement is presentation" holds again.                                             |
| 5       | One output rule: an output attaches to what you ran. Ask collapses into its answer; **Make reusable** restores the machine. Develop is Ask with an empty question.                                    | One place to look; no machine litter.                                                          |
| 6       | A chip row above the dock for the selection; the selected card's handle stays visible; Save to Workshop in the palette.                                                                               | The main verbs are visible without hover or memorised keys.                                    |
| 7       | Workshop places copies. Staleness includes the machine revision.                                                                                                                                      | Editing on one brane never changes another; a prompt edit is a change like any other.          |
| 8       | Feed has `from_placement_id` or `from_group_id`; relations are a manifest entry kind, not a digest revision; developments include references; Unplaced cards excludes outputs whose source is placed. | Each claim now maps onto an existing record or a named new one.                                |
| 9       | Cut the table shape and the phone deck; multi-model is **Compare models** for one run; the default model lives in brane settings; the pip's amber means only "needs your choice".                     | Each removed item cost a concept and served few uses.                                          |
| 10      | Added scenarios: literature matrix (via **each** and the matrix display), tune a prompt (receipt revision plus Earlier versions), quote to card.                                                      | They fall out of the model with no new noun.                                                   |

Staleness became a re-plan: compare the manifest `run-plan.ts` would produce now with
the last sealed one. That definition covers edited cards, group membership, relations
and machine revisions with one mechanism and no stored state.

### Mockup verification

The mockup at `mockup/index.html` was exercised in a browser at 1440×900:

- Editing the study card turned its feed amber, set Critique's lever to _Rerun_, put
  _Update_ on the output and turned the pip amber.
- Update replaced the output and kept the old text under _Earlier versions_.
- `D` placed a development on the claim's back and flipped it.
- Reply drew a thread line and produced a continuation.
- Drawing from the claim's edge to Diagram's slot created a feed; running it placed a
  region of five cards and five labelled arrows.
- **each** over the three-note stack produced three outputs.
- Ask over two cards collapsed into its answer with two source lines; **Make
  reusable** restored the machine with both feeds.

The mockup does not implement groups beyond stacks, the matrix display, quote to card,
or touch input.

## Iteration 3: machines and feeds in the real canvas

Iteration 3 built the machine, the feed and staleness into the running app, beside the
existing composer rather than behind a flag. Both interfaces stay usable, so they can
be compared directly. What shipped:

- **Migration 003.** The `blocks` table is rebuilt to admit kind `machine` (authored
  only), and a `feeds` table is added. Each feed links a placed card to a slot of a
  placed machine on the same brane and is removed with either placement.
- **Commands.** `text.create` became `block.create` with a kind. `feed.create` and
  `feed.remove` were added. All three sync through the offline outbox with
  dependency ordering.
- **Machine runs.** `/machines/run` and `/machines/estimate` take explicit
  `{blockId, slot}` inputs. The server checks every slot is filled and no unknown slot
  is named. It then freezes the machine revision as the prompt, labels each reference
  with its slot, and places the output to the right of the machine.
- **Canvas.** The machine card shows its prompt editor, one row per slot with chips for
  fed cards, "+ N selected", and a lever showing the estimate. To feed a slot, drag
  from a card's port onto the slot row. Feeds draw as edges into per-slot handles. A
  machine run draws one tray edge instead of per-source connectors. Changed feeds draw
  dashed amber, the machine reads _stale · evidence changed_ or _stale · prompt
  edited_, the lever becomes **Rerun**, and older outputs offer **Update**.

### Decisions taken while building

| Question                                             | Decision                                             | Rationale                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Add a `slot` column to manifest entries?             | No: the entry `label` holds the slot.                | The label is already frozen, shown and immutable; a second column would duplicate it.                                     |
| Should the server read feeds to run a machine?       | No: the client sends inputs explicitly.              | Keeps "submission resolves explicit context"; feeds remain the interface's record, and offline feeds need no server read. |
| Re-plan on the server to find staleness?             | No: project it on the client.                        | Works offline and on every keystroke-save without a request per machine.                                                  |
| Validate a feed's slot against the current template? | No: a run validates against the template it freezes. | Templates change; a feed into a renamed slot is simply not sent and shows as missing.                                     |
| Where does a new machine go?                         | The first open space right of the view centre.       | Dropped on top of cards, a machine intercepted the drags meant for their feed ports (found by the browser test).          |

### Measured: scenario 6, keep a brief current

`e2e/machines.browser.ts` runs both paths in the built app with the mock model and
counts user actions (clicks, drags and text entries; hovering is not counted). The
path: three source cards, a brief made from them, one source edited, the brief
brought up to date.

| Path     | Build the brief                        | Each update after a source edit     |
| -------- | -------------------------------------- | ----------------------------------- |
| Composer | 5 (3 × Use as context, prompt, Run)    | 2 (Reuse with current sources, Run) |
| Machine  | 7 (Add, Machine, prompt, 3 drags, Run) | 1 (Rerun)                           |

The machine costs two more actions to build and saves one on every update, so it pays
off from the third update on. It also shows, without a click, which input changed.
Scenarios 1 and 4 were not measured: they depend on the card back, the selection
chips and Ask, which iteration 3 did not build.

### Defects found by building it

- Concurrent feeds into one slot shared a command key and the later ones were
  silently dropped. Each feed is now keyed by its source cards.
- React Flow measures handles once, so feeds into a slot added by a template edit had
  no anchor. The machine card now re-measures its node whenever its slots change.
- Running inside the 650 ms autosave window would have sent the saved template's
  slots. The lever and the run request now use the draft template.
- A machine's older output offered "Reuse with current sources", which would have
  loaded the template into the composer. It now offers **Update**, which reruns the
  machine.

## Recommended iteration 4

Make outputs attach to what produced them, then measure scenario 1.

1. **Card back.** Flip any card (`F`, or a corner fold) to its back, showing the
   receipt (from `/runs/:id`) for generated cards and developments for authored ones.
   Point Develop's output at the source's back by having Spawn stop creating a
   placement.
2. **Tray history.** On rerun, move the machine's previous output off the table and
   onto the new output's back under _Earlier versions_. This removes the stacked
   responses in the screenshot `test-results/machine-flow.png`.
3. **Selection chips.** Show chips above the composer for the current selection
   (Develop, Ask, Critique, Flip). Critique creates a machine pre-fed from the
   selection, which brings scenario 1's build cost below the composer's.
4. Extend `e2e/machines.browser.ts` with scenario 1 for both paths and record the counts
   here.
