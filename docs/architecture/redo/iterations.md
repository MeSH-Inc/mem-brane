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

## Iteration 4: outputs attach to what produced them

Iteration 4 built the card back, tray history and the selection chips, and measured
scenario 1 on both paths.

- **Migration 004.** A placement gains `host_placement_id`. A placement with a host is
  drawn on that host's back instead of on the table. Triggers keep backs one level
  deep and on one brane, and removing a host removes what it holds.
- **Develop** places its output on the source placement's back, and the source card
  turns over to show it streaming.
- **Tray history.** A machine run takes the place of the machine's current output.
  The replaced output and its back move to the new output's back. Feeds it gave other
  machines move to the new output in the same slot position, so those machines go
  stale instead of running on.
- **Card back.** Every non-machine card has a flip control (↻, with a count of what
  is on the back, amber once an input changed) and the `F` key. A generated card's
  back shows its receipt: time, model, status, inputs by slot, Exact inputs and
  Update. Under it are developments and earlier versions, newest first, each with
  Exact inputs and **Put on table** (`placement.detach`, synchronized offline like
  every other command). The **Based on** strip left the front.
- **Selection chips** above the composer: **Develop** (`D`, one authored card), **Ask
  about N** (adds the cards to the prompt and focuses it; it replaces "+ Add N
  selected"), **Critique** and **Flip**. Critique places a Critique machine beside the
  selection, with the first card in reading order fed to `{claim}` and the rest to
  `{evidence}`.

### Decisions taken while building

| Question                                                         | Decision                                                        | Rationale                                                                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Leave outputs on a back unplaced, as `domain.md` first proposed? | No: a placement with a host.                                    | Every brane read is scoped by placement; a host column keeps one visibility rule instead of adding a second to each read. |
| What happens to a back when its host is removed?                 | It is removed with the host; the blocks stay in Unplaced cards. | Spilling every earlier version onto the table at stale positions would be worse than one recoverable removal.             |
| Do feeds from a replaced output follow the tray?                 | Yes, keeping their slot position.                               | A downstream machine should see the new output and offer Rerun, which is iteration 2's "the next machine goes stale".     |
| Which selected card is Critique's claim?                         | The first in reading order (top, then left).                    | Selection has no order of its own; reading order is what a person would point at first.                                   |
| What does Ask count?                                             | Distinct blocks not already in the prompt.                      | Two placements of one block are one input.                                                                                |

### Measured

`e2e/machines.browser.ts` now runs each scenario against its own server and account,
because one account polling through four paths exceeded the API's 240 requests per
minute. Counts are written to `test-results/machine-actions/`.

Scenario 6, keep a brief current:

| Path     | Build the brief | Each update after a source edit           |
| -------- | --------------- | ----------------------------------------- |
| Composer | 5               | 3 (flip, Reuse with current sources, Run) |
| Machine  | 7               | 1 (Rerun)                                 |

The composer's update rose from 2 to 3: its Reuse button is now on the response's
back. After the rerun, the table holds one brief instead of two stacked ones.

Scenario 1, pressure-test a claim (Develop the claim, then critique it with the study):

| Path     | Actions                                                 | Characters typed | Cards on the table after            |
| -------- | ------------------------------------------------------- | ---------------- | ----------------------------------- |
| Composer | 6 (Develop, flip back, 2 × Use as context, prompt, Run) | 142              | 3 (claim, study, critique)          |
| Redo     | 4 (Develop, one marquee, Critique, Run)                 | 0                | 4 (claim, study, machine, critique) |

The redo path costs two fewer actions and no writing. It leaves the Critique machine
on the table, which is what makes the next critique one press. The composer's sixth
action, flipping the claim back to reach Use as context, is a cost the card back added
to the old interface. In iteration 3 that path took 5.

### Defects found by building it

- The back's item header (label, time, Exact inputs, Put on table) overflowed a 320 px
  card. The time moved into the label's tooltip.
- Ask first counted placements, so two placements of one block read "Ask about 2".
  It now counts distinct blocks.
- Develop turns the source over, which hides that card's footer actions until it is
  turned back. Removing the footer, as recommended below, removes this.
- A machine's output is placed to the right of the machine, often outside the view,
  and nothing brings it into view. Not fixed in this iteration.

## Iteration 5: no action row, and Ask

Iteration 5 removed the card's action row, added Ask with Make reusable, revealed
machine outputs, and brought backs and machines into Focus.

- **No action row.** A card's header holds the flip control, a **⋯** menu (Develop,
  ⑂ Continue, + Use as context, Show on another brane, Version history, Remove) and
  Focus. Develop's progress and **Retry Develop** stay in the header while they apply.
  Machines get the same menu with Version history and Remove.
- **Ask.** **Ask about N** (or `/`) opens an Ask box beside or below the selection,
  whichever is nearer open space, and brings it into view if needed. It runs as a
  composed run with the selected cards as references and a new `outputGeometry`, so the
  answer takes the box's place. The composer's draft and context are untouched. Ask
  keeps its own recovery journal, as Develop and machine runs do.
- **The answer's back** shows the question, read from the run's frozen prompt entry,
  and **Make reusable**. That places a machine whose prompt is the question with one
  `{cards}` slot, fed with the same cards (`block.create` now takes a starting
  template).
- **Reply** is a chip for a selected response. It sets ⑂ Continue in the composer.
- **Reveal** moves the view only when what is revealed is out of sight, and frames a
  machine's output with its machine. A lever press now reveals its output.
- **Focus** lists table cards only. Under a card it shows the card's back (receipt,
  question, developments, earlier versions). For a machine it shows the slot rows and
  the lever, so a machine runs without the canvas.

### Decisions taken while building

| Question                                | Decision                                                                         | Rationale                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove the bottom composer now?         | No. Ask stands beside it.                                                        | The composer still carries Continue with its conversation lineage, attachments, the model choice and submission recovery. Ask replaces none of them yet.  |
| Where does Ask's answer go?             | Exactly where the box stood, through `outputGeometry` on the run request.        | The server's anchor placement slid answers away from the box. An explicit geometry is part of the request hash, so a retried delivery places it the same. |
| What does Make reusable do with braces? | Braces in the question become parentheses; the machine's only slot is `{cards}`. | A question's own braces would otherwise name slots no feed fills.                                                                                         |
| What does "+ Add N selected" become?    | It returns to the composer's context row; the Ask chip opens the Ask box.        | Adding to the composer is still how a Continue gets context.                                                                                              |
| Where do the slot rows and lever live?  | In `MachineControls`, shared by the canvas card and Focus.                       | Focus has no React Flow; the canvas passes the slot handles in. A separate module keeps React Flow out of the main bundle.                                |
| What does the app call Reply?           | ⑂ Continue, as before; the chip reads Reply.                                     | One name per relationship in the code and records; the chip names the gesture.                                                                            |

### Measured

Each composer path now takes its shortest route: one marquee and **+ Add N selected**
instead of a per-card button.

| Scenario                     | Composer                                                         | Redo                                                                   |
| ---------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1. Pressure-test a claim     | 6 actions, 142 characters typed, 3 cards on the table            | 5 actions (⋯, Develop, marquee, Critique, Run), nothing typed, 4 cards |
| 4. Ask a region (3 cards)    | 4 actions, 63 characters, 3 cards left in the composer's context | 4 actions, 63 characters, nothing left in any context                  |
| 6. Keep a brief: build       | 4                                                                | 7 (Add, Machine, prompt, 3 drags, Run)                                 |
| 6. Keep a brief: each update | 3 (flip, Reuse with current sources, Run)                        | 1 (Rerun)                                                              |

The redo's scenario 1 rose from 4 to 5: Develop moved from the action row into the
menu (or select and `D`, also two). Scenario 4 costs the same on both paths. The
difference is what remains: the composer keeps the three cards as context for the next
run, and its answer lands beside the first card wherever there is room. Ask leaves no
context, and its answer stands where it was asked. Building a brief from the
composer's best path (4) now costs less than building a machine (7).

### Defects found by building it

- The header menu drew under the card below it. A node now rises while its menu is
  open.
- The Ask box never took focus: React Flow keeps a node hidden until it has measured
  it. The box retries focus each frame until it is shown.
- With cards and machines to the right of a selection, the box opened far off-screen.
  It now also tries below the selection and is brought into view.
- Importing the shared machine controls from the canvas card would have put React
  Flow in the main bundle. They live in their own module.

## Recommended iteration 6

Retire the bottom composer and make building a machine as cheap as asking.

1. **Continue in the Ask box.** The Reply chip opens an Ask box with `continueFrom`
   set, drawn with a thread line to the response. Attachments drop onto the table as
   cards, and the model choice moves to the brane's settings. The submission recovery
   notices move into the box. Then delete the composer and its context state, as
   `domain.md` already lists.
2. **Machine from a selection.** A **Machine** chip places a machine with one
   `{cards}` slot fed by the selection, like Critique. Scenario 6's build drops from 7
   to 4 (marquee, Machine, prompt, Run).
3. **Arrows.** Draw a labelled arrow between two cards (the last step of scenario 1),
   stored as a brane-scoped relation and sent when both ends are inputs of one run.
4. Measure scenarios 1, 4 and 6 with the composer gone.
