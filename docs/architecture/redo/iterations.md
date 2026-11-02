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

## Iteration 6: the prompt moves onto the table

Iteration 6 retired the bottom composer on the desktop canvas and added the Machine
chip. Arrows were deferred (see the decisions).

- **The Ask box is the composer.** On the desktop canvas, the prompt panel lives in an
  Ask box on the table: its context chips, attachments, question, Run, estimate and
  refusal notices. It opens from **Ask about N** (the selection becomes its context),
  **Reply** and ⑂ Continue (beside the response), **+ Use as context** (beside the
  card), **Reuse with current sources** (beside the answer), the toolbar **Ask** and
  `/`. Its answer takes its place. Closing it keeps the draft. Focus and phones keep
  the same panel docked at the bottom, because there is no table to put it on.
- **One way to ask.** Iteration 5's separate Ask request and journal are gone. The Ask
  box runs the composer's request, with its recovery, estimate and Continue, plus
  `outputGeometry`. An accepted run clears its question, context and Continue.
- **The bottom line** holds only the selection chips, the model menu and the save
  status.
- **Machine chip.** It places a machine beside the selection with one `{cards}` slot
  fed by every selected card, and its prompt ("Summarise {cards} in five sentences.")
  ready to edit.
- **Every receipt has Exact inputs**, including runs with no sources.

### Decisions taken while building

| Question                                    | Decision                                                                          | Rationale                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebuild the composer's features for Ask?    | No: move the composer's panel into the Ask box and drop the separate Ask request. | Continue, attachments, estimate, refusal notices and submission recovery come along unchanged, and there is one prompting path instead of two.  |
| Where does the prompt live without a table? | Docked at the bottom in Focus and on phones.                                      | A box placed on the table needs the table; those views already show one card at a time.                                                         |
| What remains after a run?                   | Nothing: the question, its context and Continue clear once accepted.              | They belonged to that question. Iteration 5 measured the composer leaving three cards in context for the next, unrelated run.                   |
| Move the model choice to brane settings?    | No: it stays in the bottom line, beside the save status.                          | It applies to Develop and machines as well, and a brane setting would need a new stored record for no new behaviour.                            |
| Build arrows in this iteration?             | No, deferred to iteration 7.                                                      | An arrow needs a relation record, a migration, two synchronized commands, a drawing gesture and a manifest entry kind: an iteration of its own. |

### Measured

The second path is now Ask: the same app, with the question written out.

| Scenario                     | Ask                                                       | Machine and chips                                                   |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| 1. Pressure-test a claim     | 6 actions, 142 characters typed, 3 cards                  | 5 actions (⋯, Develop, marquee, Critique, Run), none typed, 4 cards |
| 4. Ask about three cards     | 4 actions (marquee, Ask about 3, question, Run), 63 typed | n/a                                                                 |
| 6. Keep a brief: build       | 4 (marquee, Ask about 3, prompt, Run)                     | 4 (marquee, Machine, prompt, Run)                                   |
| 6. Keep a brief: each update | 3 (flip, Reuse with current sources, Run)                 | 1 (Rerun)                                                           |

The Machine chip brought scenario 6's build from 7 to 4, level with asking, so a
machine now costs nothing extra and saves two actions on every update. Scenario 4's
answer is checked to stand at the box's exact table position.

### Defects found by building it

- The scenario servers shared ports with the import and workspace-recovery suites,
  and parallel workers collided. They now use 4201 to 4203, which no other suite uses.
- A run with no sources showed no Exact inputs on its back.
- Handlers rebuilt on every render would have re-rendered every card on each
  keystroke in the Ask box. The canvas now receives stable callbacks.
- Resizing to a phone layout with the box open would have kept it on a table that
  phones do not show.

## Iteration 7: arrows, Update, and the Ask sheet

Iteration 7 added the second kind of link, gave asked answers an Update, and removed
the always-docked prompt from Focus and phones.

- **Arrows.** Drag a card's port onto another card (not a slot) and pick a word:
  _answers_, _supports_, _contradicts_, _extends_, or type another. The arrow is a
  straight line between the two cards' nearest borders, with its word on a chip that
  carries its one action, ×, which removes it. Arrows are stored in a new `relations`
  table (migration 005) and synchronized like feeds, through the offline outbox as
  `relation.create` and `relation.remove`. Removing either card removes the arrow, and
  a machine rerun or an Update moves the arrows of the card it replaces onto the new
  one.
- **Arrows reach the model.** A run whose inputs include both ends of an arrow freezes
  a `relation` entry before its prompt, for example "Reference 2 answers Reference 1."
  The model receives it as "[Relation between reference materials] …". An arrow with
  only one end among the inputs sends nothing.
- **Update for asked answers.** When an answer's source has changed, its back shows
  **Update** beside the question. Update asks the same question over the same cards'
  current text, with the same branch. The new answer takes the old one's place, and
  the old one goes on its back as an earlier version, as with machine reruns
  (`replacesPlacementId` on the run request). The Ask box's own draft is untouched.
- **The Ask sheet.** Focus and phones open the prompt as a sheet over the bottom bar,
  from the same places as the desktop Ask box: the toolbar **Ask** (now on every
  view), `/`, **+ Use as context**, **Reply** and ⑂ Continue. It closes when its
  question is accepted, when **×** or Escape is pressed, or never by itself while a
  newer question is written. It opens on its own when the brane opens with an unsent
  question or a Run whose delivery is unconfirmed, and an Ask box open on the table
  becomes the sheet when the view loses its table. The bottom bar now holds only the
  selection chips, the model and the save status, everywhere.

### Decisions taken while building

| Question                                           | Decision                                                                                                         | Rationale                                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How does a relation entry hold its text?           | As a frozen, unplaced text revision, like an Ask's prompt, with kind `relation` (domain.md said a label column). | `context_entries.revision_id` is required and sealed; a revision keeps the entry immutable, owned and readable through the existing input reader, with no new column. |
| How does a relation name its ends?                 | By the ends' entry labels; with the frozen revision added when two inputs share a label (one slot, many cards).  | The model already sees each input under its label and revision, so the relation points at text it can find. Slot labels repeat; revisions do not.                     |
| Is the arrow's word optional?                      | No: required, 1 to 60 characters, chosen from four offered words or typed.                                       | A relation with no word tells the model nothing it can use. Offering four words keeps naming one press.                                                               |
| Can an arrow end on a machine or a card on a back? | No: both ends are cards on the table.                                                                            | A machine is never an input, so the arrow could never be sent; a card on a back is not drawn.                                                                         |
| How do runs see an arrow drawn while offline?      | `/runs` and `/machines/run` wait for every pending arrow change on their brane.                                  | The server reads arrows at admission. Arrow commands write one resource per brane, so a run synchronizes them first, as it does its sources' text.                    |
| Relabel an arrow?                                  | Not in this iteration: remove it and draw it again (two presses).                                                | A relabel command is a third synchronized command for a rare edit; it joins arrow staleness in iteration 8.                                                           |
| Does a new arrow make earlier runs stale?          | Not yet.                                                                                                         | Staleness compares what a run froze, and workspace runs do not yet project their relation entries. Iteration 8 projects them, together with group membership.         |
| Where does Update live?                            | On the answer's back, beside its question, only when a source changed.                                           | The flip control already turns amber when a source changes; Update is the next press there. Showing it on fresh answers would invite paid reruns that change nothing. |
| Hide the sheet when it holds a draft?              | It may be closed, keeping the draft, but it opens with the brane when a question is unsent or a Run unconfirmed. | A closed sheet must not hide work the recovery paths exist to protect, and an always-open sheet would be the docked composer again.                                   |

### Measured

| Scenario                     | Ask                                                       | Machine and chips                                                              |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1. Pressure-test a claim     | 8 actions, 142 characters typed, 3 cards                  | 7 actions (⋯, Develop, marquee, Critique, Run, drag arrow, _answers_), 4 cards |
| 4. Ask about three cards     | 4 actions (marquee, Ask about 3, question, Run), 63 typed | n/a                                                                            |
| 6. Keep a brief: build       | 4 (marquee, Ask about 3, prompt, Run)                     | 4 (marquee, Machine, prompt, Run)                                              |
| 6. Keep a brief: each update | 2 (flip, Update)                                          | 1 (Rerun)                                                                      |

Scenario 1 is complete for the first time: the arrow costs two gestures on either
path, and a run over the objection and the claim is checked to send "Reference 2
answers Reference 1." Scenario 6's asked update fell from 3 to 2, and is checked to
put the new answer at the old one's exact position with the old one on its back.

### Defects found by building it

- React Flow's handle routing sent an arrow from the right side of a card that stood
  to the right of its target, looping behind the cards between them. Arrows are now
  straight lines between the cards' nearest borders.
- Arrow words drew under the cards, and under a selected card in particular, which
  React Flow raises to z-index 1000. Labels now draw at 1001, and an open card menu
  moved to 1002 to stay above them.
- Focus's own **+ Use as context** added the card without opening the sheet, so the
  context went somewhere unseen.
- A Retry that reconciled an unconfirmed Run closed the sheet over the newer question
  written meanwhile.
- Replicas stored before this iteration have no arrow list; IndexedDB version 4 adds an
  empty one.
- The guest-claim browser test failed about one run in three. Its session poll could
  leave with the guest cookie before the intercepted sign-in committed; Better Auth
  then answered that the guest session no longer existed and cleared the new session
  cookie. The test now polls only after the sign-in commits. The iteration 6 commit
  never failed it in seven runs, so this iteration's timing exposed the race rather
  than created it.
- The keyboard-focus check in `canvas.browser.ts` fails about one full run in seven, on
  the iteration 6 commit as well. It is not addressed here.
- An arrow's line still passes under any card standing between its ends; only its word
  stays above them.

## Iteration 8: groups, and staleness that sees arrows and groups

Iteration 8 added the third structure on the table, made arrows rewordable, and taught
staleness about both.

- **Groups.** Marquee cards and press `G` (or the **Group** chip): they become a
  region, a dashed frame round the cards where they lie, labelled _Group 1_ with its
  count. Pressing the frame's header selects the group; dragging it moves every
  member. ✎ renames it. With the group selected the chips offer **Stack**, which piles
  the members into the first one's space with three edges showing, and **Spread**,
  which lays a stack back out on a grid; a press on any card of a stack moves the whole
  stack. **Ungroup** leaves the cards where they are; **Take out of group** in a card's
  menu removes one. `G` on a selection that includes one group's cards and loose
  cards adds the loose cards to that group. Groups are stored in `groups` and
  `group_members` (migration 006) and synchronized through the offline outbox as
  `group.create`, `group.edit` and `group.remove`.
- **A group feeds as one.** The frame's header has a port; dragging it onto a slot
  feeds the group (`feeds.from_group_id`). The slot row shows one chip, _Group 1 · 12_.
  The lever sends the group's current members in member order, frozen at the press;
  the run's manifest is unchanged, one reference entry per card.
- **Staleness sees arrows and groups.** Each run's relation entries now keep their
  structure (`relation_entries`: the two entries joined and the word), and the
  workspace read carries every visible run's sent arrows as `relationEntries`. A
  machine is stale when an arrow between its fed cards is drawn, reworded or removed
  (_stale · arrows changed_), or when a fed group gains or loses a card (the slot's
  name, and the group's feed turns amber). An asked answer offers **Update** for the
  same reasons, and its back lists the arrows it sent (_Arrows sent_).
- **Rewording an arrow.** Pressing an arrow's word reopens the word picker with the
  current word marked (`relation.relabel`). A run keeps the word it froze.
- **Arrows in Focus and on phones.** Under a card's back, Focus lists its arrows as
  sentences (_This card answers …_, _… contradicts this card_), each with ×.

### Decisions taken while building

| Question                                          | Decision                                                                                                               | Rationale                                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Is a stack a hidden set of cards or a layout?     | A layout: Stack writes each member's geometry onto a pile, Spread writes a grid.                                       | Every member stays a drawn node, so marquee, arrows, feeds and live updates need no second visibility rule; a pile is what a stack looks like. |
| Can a card be in two groups?                      | No: one group per card, enforced by `UNIQUE(placement_id)`.                                                            | A region moves its members; two regions sharing a card would drag each other.                                                                  |
| Which order does a group feed in?                 | Member order: reading order of the selection when grouped, joining cards appended.                                     | Recomputing reading order at the press would reorder a stack, whose members all stand in one place.                                            |
| How does a card join or leave a group?            | Join: select it with the group and press `G`. Leave: **Take out of group**. Dropping a card into a frame does nothing. | One key covers creating and growing; a drop-to-join would make every drag across a region a membership change.                                 |
| What happens to an empty group?                   | It is removed with its feeds, by trigger on the server and by the same rule in the replica.                            | A group with no cards has nothing to show or send.                                                                                             |
| How is a group edited?                            | `group.edit` states the whole group (label, display, members); the last edit wins, without a version.                  | Groups are small and edited by one person at a time; a version check would add a conflict dialog for a label.                                  |
| A card fed alone and inside a fed group?          | It fills the slot once, at its first feed.                                                                             | Sending one card twice in one slot doubles its weight without the user asking.                                                                 |
| How does the client know which arrows a run sent? | `relation_entries` keeps each relation entry's two entry positions and word, sealed with the context.                  | The entry's frozen text names labels, not blocks; parsing it back would break when two inputs share a label.                                   |
| What makes an arrow change stale?                 | The set of (from block, to block, word) between the inputs differs from the set the last run sent.                     | That is exactly what asking again would send differently; arrows touching only one input change nothing.                                       |
| Do groups appear in Focus and on phones?          | Not in this iteration; Focus lists cards and their arrows.                                                             | A group adds no text to read, and feeding a group needs a drawn port; the phone's machine form (iteration 10) is where a group picker belongs. |

### Measured

| Scenario                                 | Actions                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| 2. Reading pile, up to feeding the stack | 5 (drop, marquee, `G`, Stack, drag the port onto the slot) |
| 4. Ask a region, grouped first           | 5 (marquee, `G`, Ask about 3, question, Run), 63 typed     |
| 4. Ask a region, ungrouped (iteration 7) | 4                                                          |

Scenario 2 runs to the slot for the first time: the stack's single chip reads
_Group 1 · 12_, the run is checked to send all twelve cards in reading order under the
slot's name, and taking one card out turns the machine _stale · text changed_ with the
frame reading _Stack · 11_. Split itself is placed by the test, since the Workshop does
not exist yet. Grouping costs scenario 4 one press; what it buys is a region that can
be moved, fed and asked about again without another marquee. The answer's back lists
the arrow it sent, and rewording that arrow makes **Update** appear.

### Defects found by building it

- React Flow styles its own node type `group` with a border and padding, which drew a
  second frame inside the first. The frame's node type is now `cardGroup`.
- An open card menu on the top card of a selected stack drew under the cards beneath
  it, which a selection raises past the menu's z-index. A stack's depth is now capped
  at four layers, and an open menu draws at 1010.
- A feed from a card onto its own machine reported "Both ends must be placed" instead
  of "A machine cannot feed a machine" once group sources were added; the kind check
  runs first again.
- Replicas stored before this iteration have no groups or sent arrows; IndexedDB
  version 5 adds empty lists.

## Iteration 9: each, and the Workshop

Iteration 9 let one press run a machine once per card, and gave machines a place to be
kept and taken from.

- **Each.** A group's chip on a slot row now carries a toggle, _together_ or _each_.
  With _each_, the lever reads `Run ×12 · ≈ $…` and one press admits one run per card
  of that slot, every other slot's cards going to every run. The runs are admitted in
  one transaction: all are frozen and reserved at the press, or none are. They share a
  batch (`run_batches`, migration 007), and a retry takes its run's place in it. The
  mode is the one part of a feed that may change (`feed.mode`, synchronized through the
  offline outbox); only a group feed may run each, and only one slot of a machine.
- **Outputs arrive as a stack.** The first press makes a stack named _Each source_
  beside the machine, in the slot's order. A rerun puts each new output in its
  predecessor's place in the stack, with the old one on its back; outputs past the
  stack's end join it, and old ones with no new counterpart go on the first output's
  back. Switching back to _together_ leaves one output where the stack was, with the
  stack's cards on its back.
- **Staleness compares presses.** What the last press froze is every run of its batch
  in position order, so a card added to or taken out of the fed stack, or a change of
  mode, marks the machine stale, as an edited card does.
- **Run limits count presses.** A batch counts once against the per-account and
  queue limits, and workers now take the oldest queued run of the owner with the
  fewest runs under way, so a dozen runs from one press do not hold every worker.
- **The Workshop.** **＋ Add → ⚒ Workshop** lists Critique, Distill and Extract and the
  account's saved machines, each with its slots and prompt. Pressing one places a new
  machine with a copy of the prompt, brought into view and selected. **Save to
  Workshop** in a machine's ⋯ menu keeps its prompt, named by its opening words, and
  opens the Workshop to show it; × removes a saved one.

### Decisions taken while building

| Question                                                        | Decision                                                                                                                             | Rationale                                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where does _each_ live?                                         | On the feed, as `mode`; only group feeds offer it, and a slot runs each when any of its feeds does.                                  | The concept puts the toggle on the slot row beside the group; a mode on the feed survives template edits that rename other slots.                |
| Can two slots run each?                                         | No: refused on the server and in the replica, and the lever reads _One slot runs each_ if it happens.                                | Two lists would fan out into every pairing, which the user never asked for and the lever could not state honestly.                               |
| How many runs may one press admit?                              | At most 12.                                                                                                                          | Scenario 2's dozen papers; more is a batch job, not a press.                                                                                     |
| How does a batch meet the run limits (3 per account, 8 queued)? | It counts once, and workers share themselves fairly between owners.                                                                  | Counting each run would make _each_ impossible under the existing limits; fairness keeps one account's batch from starving another's single run. |
| How is a repeated press recognised?                             | Run _i_ of a batch has a key derived from the press's key; a press whose first key exists returns its runs without placing anything. | The submission journal retries with the same key; replays must not move the tray twice.                                                          |
| Where do edits sent with a press go?                            | They are saved once, before the first run; every run reads the saved text.                                                           | Each run freezing its own copy of the same edit would conflict on the block's version.                                                           |
| What is a Workshop item?                                        | A stored prompt with a name (`workshop_machines`), not an unplaced machine block.                                                    | It is only ever copied; as a block it would need revisions and would appear among Unplaced cards.                                                |
| How is a saved machine named?                                   | By the prompt's words before its first slot (_Split_ from "Split {text} into…"), else its first 60 characters.                       | Naming is one more dialog for something the prompt already says.                                                                                 |
| Does the Workshop work offline?                                 | Reading it does once loaded; saving and removing need the connection.                                                                | The Workshop is the account's, not a brane's, so it is outside the brane outbox; taking a machine out is an ordinary offline-capable creation.   |

### Measured

| Scenario                                                      | Actions                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 2. Reading pile, through `Run ×12`, Extract from the Workshop | 10 (drop, marquee, `G`, Stack, Add, Workshop, Extract, drag the port, _each_, Run ×12)                |
| 3. Three Extract machines over one stack of four, each        | 25 (drop, marquee, `G`, Stack; then per machine: Add, Workshop, Extract, question, port, _each_, Run) |

Scenario 2 now runs to its twelve outputs: each run is checked to send one paper, in
the stack's order, and the outputs arrive as one stack reading _Stack · 12_. Of its ten
actions, three take Extract out of the Workshop; with Split there in iteration 10 the
count is unchanged. Scenario 3 reaches its three output stacks, twelve runs in three
batches. Its cost is seven actions per question, of which three are the Workshop; the
matrix display (iteration 10) is what turns the three stacks into one table.

### Defects found by building it

- A machine placed from the toolbar or the Workshop landed in the first open space to
  the right of the view's centre, which could be outside the view; with the table full
  the second Extract of scenario 3 was placed out of sight. A new machine is now
  brought into view.
- Under the existing run limits (three runs under way per account, eight queued in
  all), a press of twelve runs would always have been refused; see the decision above.
- Browser tests that dragged right after fitting the view read positions from before
  the view moved; the drag helper now waits two frames.

## Iteration 10: outputs of several cards, and the matrix

Iteration 10 let a machine's answer arrive as several cards, and set the outputs of
machines run each over one stack out as a table.

- **The prompt declares the output.** A prompt whose last line reads `Output: cards`
  or `Output: diagram` has its answer placed as one card per numbered item. Without
  the line an answer is one card, as before. The declaration is part of the frozen
  prompt revision, so a saved or copied machine carries it, and changing it is an edit
  that makes the machine stale.
- **Split and Diagram.** Both are in the Workshop. Split asks for one numbered line per
  idea and declares cards; Diagram asks for numbered ideas and then relation lines
  such as `2 —supports→ 1`, and declares a diagram.
- **Parts.** When such a run completes, the server adds one generated card per item
  (`run_parts`, migration 008) where the answer lay, in the completion's transaction,
  and puts the whole answer on the first card's back. Alone, the cards arrive as a
  stack named after the machine (_Split_), or for a diagram as a region laid on a grid
  with the arrows drawn. If the answer was in a group, the cards take its place there
  in order, so Split run each over a stack of papers yields one stack of every paper's
  ideas, in paper order. Each card is an output of the run: its back shows the frozen
  inputs, it goes stale when they change, and a rerun replaces the whole set, the old
  cards going onto the new answer's back.
- **The matrix.** `G` over cards of several groups now merges them into the first
  group. For a group whose cards are outputs of machines run each, the chip row offers
  _Matrix_: a column per machine, headed by its prompt's last question, and a row per
  card the machines ran over, headed by that card's first line. The matrix is laid
  clear of other cards and machines. A machine rerun each replaces its own column.
- **One read per burst of status reports.** A run's start and end each made the page
  read the whole brane and the budget again; reports now gather for 200 ms before one
  read.

### Decisions taken while building

| Question                                                          | Decision                                                                                                                               | Rationale                                                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where is an output's shape declared?                              | In the prompt's last line, `Output: cards` or `Output: diagram`.                                                                       | The prompt already decides the slots; a separate setting would be a switch the prompt does not show, and would need its own field on machines and Workshop items. |
| Who splits the answer?                                            | The server, in the transaction that completes the run.                                                                                 | The split must happen once, with the tab closed or open, and belong to the run's record; completion is the one moment that holds the whole text.                  |
| What is a card an answer was split into?                          | A generated block with one revision, listed in `run_parts`; the run's output is still the whole answer, kept on the first card's back. | Every read finds a run by its output. Parts that join the derivations, rather than replace the output, need no second rule for backs, staleness or Update.        |
| Where do the cards go when the answer was in a group?             | Into that group, in its place, in item order.                                                                                          | Split run each over a stack then gives one stack of all the ideas, which is what Diagram is fed next.                                                             |
| What does an answer with one item, or none, do?                   | It stays one card.                                                                                                                     | A stack of one is a card.                                                                                                                                         |
| How many cards may one answer make?                               | 24. Items past the 24th stay in the whole answer; no split happens if the group would pass 200 cards or the brane is out of room.      | One answer that floods the table is not an answer anyone reads; the whole text is never lost.                                                                     |
| What happens to a relation line naming an item that is not there? | It is dropped; the whole answer on the first card's back still shows it.                                                               | The receipt is written at the press, before the answer exists; the back already holds the full text, so a separate report would repeat it.                        |
| How is a diagram laid out?                                        | On a grid in item order, framed as a region.                                                                                           | Its next step in scenario 2 is the user's own rearranging; a layout from the arrows is recommended next.                                                          |
| How do three stacks become one matrix?                            | `G` over cards of several groups merges them into the first group, which keeps its name, display and feeds.                            | Scenario 3 lassoes three stacks; refusing because they were in different groups ended it there.                                                                   |
| What are a matrix's rows and columns?                             | A card's column is the machine that produced it; its row is the card its run ran over, the input no other run of its batch sent.       | Both are read from runs and derivations the workspace already holds; nothing new is stored, and the display stays presentation.                                   |
| Where is a matrix laid?                                           | From its cards' top left corner, moved right past any card or machine it would cover.                                                  | The three stacks lie between their machines; laid where they were, the matrix covered the machines.                                                               |
| What does a machine's rerun do to a matrix it shares?             | It replaces its own column: a machine's tray in a group that holds other machines' outputs is its own outputs there.                   | Without this, a rerun after regrouping added its outputs to a second group, which the database refuses.                                                           |
| How often does a run's status report read the brane?              | Once, 200 ms after the first report, for every report that arrives meanwhile.                                                          | A press of twelve runs made 48 requests; with the page's own saves that reached the account's limit of 240 a minute in scenario 3.                                |

### Measured

| Scenario                                                           | Actions                                                                                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 2. Reading pile, through Split each, Diagram and one rearrangement | 16 (drop, marquee, `G`, Stack, Add, Workshop, Split, port, _each_, Run ×N, Add, Workshop, Diagram, port, Run, drag one card) |
| 3. Three Extract machines over one stack, each, through the matrix | 28 (the 25 of iteration 9, then marquee the three stacks, `G`, Matrix), 188 characters typed                                 |

Scenario 2 now runs to its end. The browser test splits three papers of two sentences
each into one stack of six ideas in paper order, feeds that stack to Diagram, and gets
a region of six cards with five arrows drawn, one of which the user then drags. The
count does not depend on how many papers there are. Scenario 3 reaches its table: four
rows headed by the papers, three columns headed by the questions, each paper's three
answers level with each other. Of its 28 actions, 9 take Extract out of the Workshop
three times and 3 type the questions; a machine that could be duplicated with its feed
would cut most of them.

### Defects found by building it

- `G` over cards from several groups was refused ("These cards are in different
  groups"), which ended scenario 3 before the matrix. Grouping now merges them.
- A machine whose outputs had been regrouped with other machines' outputs could not be
  rerun each: the tray took any group holding its newest output to be its own, and
  tried to add the new outputs to a second group, which the database refuses.
- Each run's start and end made the page read the whole brane and the budget: four
  requests per run, 48 for one press of twelve. In scenario 3 the browser test reached
  the account's request limit and the page reported _Too many requests_.
- A matrix laid where its stacks lay covered the machines between them.

## Iteration 11: Compare models, and the output shape on the machine

Iteration 11 let one press ask several models, made a machine's output shape something
to choose rather than type, laid diagrams out by their arrows, and let a machine be
copied with its feeds.

- **Compare models.** **Compare models…** in a machine's ⋯ menu opens a picker under
  its slots. With two or more models ticked the lever reads `Run ×2 models`, and one
  press admits one run per model over the same inputs, as one batch. The answers stand
  side by side at the tray, each naming its model with a **Keep** button; Keep leaves
  that answer on the table and puts the others on its back. The choice is for that
  press only: the picker closes with it. A rerun puts each new answer in its
  predecessor's place; a run together leaves one answer.
- **A second local model.** `mock-brief` answers in one line, in process and free, so
  comparisons can be tried and tested without a provider.
- **The output shape on the machine.** A machine whose prompt declares cards or a
  diagram shows _→ cards_ or _→ diagram_ beside its lever. Its ⋯ menu offers _Answer
  as one card_, _as cards_ and _as a diagram_, which rewrite the declaration line and
  nothing else of the prompt.
- **Diagrams laid out by their arrows.** Each card sits one row below the cards with
  arrows into it, so every arrow points down the page; cards whose arrows go round in a
  cycle keep the grid.
- **Duplicate with feeds.** A machine's ⋯ menu places a copy below it with the same
  prompt, unsaved edits included, fed from the same cards and groups in the same slots
  and modes. The copy is brought into view and selected, ready for a new question.
- **Live check.** `scripts/check-machine-output.ts` runs the built-in Split and
  Diagram against a live model on twelve invented abstracts and reports how the
  answers parse.

### Decisions taken while building

| Question                                    | Decision                                                                                                          | Rationale                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where are the models to compare chosen?     | In a picker under the machine's slots, opened from its ⋯ menu.                                                    | Machines have no back yet; building one for a single control would add a surface to reach before the control.                                                   |
| Is the choice kept?                         | No. It lives in the page for the machine's next press and closes with it.                                         | The concept says the choice applies to that run only; a remembered comparison would multiply every later press's cost unseen.                                   |
| Can a comparison run each?                  | No: refused by the server, and the lever reads _Compare with the cards together_.                                 | Models times cards is a grid of runs the lever could not state in one figure.                                                                                   |
| What is Keep?                               | A request to the server (`POST /runs/:id/keep`) that puts the press's other loose answers on the kept one's back. | Running a comparison already needs the connection, so its last step does not need the offline outbox; the move is the tray's existing rule for retired answers. |
| What does a comparison's staleness compare? | What its first run froze.                                                                                         | Every run of a comparison froze the same inputs; compared run after run, as each is, every comparison read as stale.                                            |
| How is the output shape chosen?             | By menu items that rewrite the prompt's last line.                                                                | The prompt stays the one authority (iteration 10); the menu spares the wording.                                                                                 |
| How is a diagram laid out?                  | In rows by arrows, each card one row below the cards pointing to it; a cycle falls back to the grid.              | Arrows then read in one direction, which a grid in item order did not give.                                                                                     |
| What does Duplicate copy?                   | The prompt, unsaved edits included, and every feed with its slot and mode; never the runs.                        | The copy exists to ask something else of the same material; scenario 3's second and third machines differ only in their question.                               |
| Must every Split answer split?              | No. A text with one idea stays one card.                                                                          | Live, the two abstracts that stated one finding each gave one item; a prompt that forced two would invent an idea.                                              |
| What did the live check change?             | Diagram's prompt now says a relation joins two different ideas and an idea that relates to none goes without one. | Over four unrelated papers DeepSeek wrote `3 —supports→ 3` for every idea; the parser dropped them all, and one run gave two ideas for four papers.             |

### Measured

| Scenario                                                                       | Actions                                                                                                  |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 5. Pick a model by looking, from a fed machine                                 | 6 (⋯, Compare models…, tick, tick, `Run ×2 models`, Keep)                                                |
| 3. Three Extract machines over one stack, each, through the matrix, duplicated | 22, from 28 (the second and third machine: ⋯, Duplicate with feeds, question, Run), 188 characters typed |

Live check against `deepseek-chat`, after the Diagram prompt change: 11 of 12 Split
answers split, into 1 to 3 cards (the one that did not stated a single finding); the
three Diagrams over four papers each gave 6, 4 and 4 cards with 2, 0 and 2 arrows and
no line dropped. The middle four papers share no relation, and the answer said so by
drawing none.

### Defects found by building it

- Over unrelated material the Diagram prompt drew each idea supporting itself; see the
  decision above.
- A duplicate's feeds were created before the workspace held the copy, so the first
  attempt fed nothing; the copy is now read back before it is fed.

## Iteration 12: Machines that feed machines, and the back of a machine

Iteration 12 let one machine's answers feed another machine, so a change upstream
reaches the end of a chain one press at a time, and gave a machine a back.

- **A tray feeds a slot.** A machine has a port beside its lever. Dragging it onto
  another machine's slot feeds that slot what the tray holds: the newest answer, or the
  stack an each press made, or the cards an answer was split into. The feed follows the
  tray: a rerun, a press each or together, a split and Keep each move it to whatever
  the tray now holds, in the same place in the slot. Nothing downstream runs by itself.
  A machine that has not run says _Run this machine before feeding its answers to
  another._
- **Loops are refused.** A feed whose cards come from the target machine, or from any
  machine it feeds, is refused as it is drawn: _This feed would close a loop: the
  machine would feed its own input._ The check runs in the offline replica and again on
  the server.
- **Update along a chain.** After an upstream rerun the downstream machine reads
  _stale · material changed_ and its lever _Rerun · $…_ with its own estimate. An edit
  to a source makes only the first machine stale; each machine is pressed once.
- **The back of a machine.** ↻ in a machine's header, or `F` with it selected, turns
  it over. The back shows the prompt's version (and, when the prompt was edited since,
  the version the last press ran), the models to compare on the next press, the lever,
  and every past press, newest first: when, which models, how many runs and how they
  ended, and what it cost once settled.
- **Compare models moved to the back.** The ⋯ menu item and the picker under the slots
  are gone. A comparison is chosen and pressed on the back, which then lists the press.
- **Settled cost in the brane read.** Each run carries `confirmed_microusd`, the cost
  of its settled usage, so the back can sum a press without a request per run.

### Decisions taken while building

| Question                                             | Decision                                                                                                                      | Rationale                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does a tray feed record?                        | An ordinary feed from the tray's card or group; a machine is still never a feed's source.                                     | Runs already send cards; a feed from a machine would be a second source kind whose inputs depend on run history, read by staleness, estimate and run alike. |
| How does the feed follow the tray?                   | The server moves a tray's feeds wherever the tray changes shape, keeping each feed's position in its slot.                    | Reruns already moved a replaced card's feeds; the same move at the four other points (each, together, split, Keep) covers every shape the tray takes.       |
| What does a tray feed hold when the tray is a group? | The group, when every card in it came from the feeding machine; otherwise the newest card.                                    | A stack the machine made is its answer; a shared group such as a matrix is not, and feeding all of it would send other machines' answers.                   |
| What is a loop?                                      | A feed whose cards were produced by the target machine or by a machine downstream of it, through any number of machines.      | Producers are read from the runs' anchors, which the workspace already holds, so the same check runs offline and on the server.                             |
| Where are presses grouped?                           | By batch: an each press or a comparison is one press; a run alone is its own.                                                 | The batch is the press as the server admitted it; the lever's one press is what the back lists.                                                             |
| What does the back say about cost?                   | The sum of the press's settled costs; _cost pending_ while a run is under way, _cost not known_ if a run ended without usage. | The settled cost is the one figure that is true; the held amount is already shown on the lever before the press.                                            |
| Is the lever on the back?                            | Yes, below the models to compare.                                                                                             | Choosing models and pressing are one step; flipping back to press cost an action for nothing.                                                               |
| Where is a machine's tray port?                      | Beside its lever, not at the middle of its right edge as on a card.                                                           | A selected machine's resize handle sits at the middle of its edge and took the drag; the lever is also where the answers come from.                         |
| Is the prompt's version called a revision?           | No; the back says _version_, as Version history and the runs' `machine_version` do.                                           | One name per concept: the version number is what the history and staleness already use.                                                                     |

### Measured

| Scenario                                       | Actions                                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 6. Sources into Distill into a Brief, built    | 15 (drop, lasso, `G`, Stack, Add, Workshop, Distill, port, Run, Add, Machine, prompt, fit view, Distill's port, Run), 57 characters typed |
| 6. The same chain after a source is edited     | 3 (the edit, Rerun on Distill, Rerun on the Brief)                                                                                        |
| 5. Pick a model by looking, from a fed machine | 5, from 6 (↻, tick, tick, `Run ×2 models` on the back, Keep)                                                                              |
| 1. Pressure-test a claim                       | 7, unchanged since iteration 8, nothing typed, 4 cards                                                                                    |

Scenario 6 runs end to end for the first time. Of its 15 building actions, the second
machine costs 6 (Add, Machine, the prompt, fit view, the port, Run); a Brief in the
Workshop would remove the typing. Keeping the chain current costs one press per machine
after the edit, which is what the concept asked: nothing downstream spends without a
press. The browser test also draws the Brief's tray back into Distill and sees it
refused with the slot unchanged. Scenario 1 needed no change and still takes 7.

### Defects found by building it

- A press together on a machine whose answers were a stack deleted the stack and with
  it every feed from it, so a downstream machine lost its input. The stack's feeds now
  move to the one card first.
- An answer split into cards, or a compared answer that was not kept, kept or dropped
  its feeds by accident of which card took the output's place. Both now move them.
- A selected machine's resize handle covered its new tray port; see the decision above.
- Revealing a new answer moves the view, and in scenario 6 it moved Distill out of
  sight twice, so the test fits the view before drawing from it. A chain wider than the
  screen needs a way to draw a feed without both ends in view.

## Iteration 13: chains that are easy to build and to read

Iteration 13 let a chain be built without both machines in view, showed which machine
a chain is waiting on, and let one press rerun a chain in order.

- **Feed from a slot.** A slot row offers _Feed from…_, listing by name every machine
  whose tray could feed it: run, not the machine itself, not feeding that slot already,
  and not downstream of it. Choosing one makes the same feed as dragging that machine's
  port. A slot with nothing to offer shows no menu, so a loop is never offered.
- **Brief in the Workshop.** A built-in Brief machine: _Write a brief from {material}
  in five sentences: the situation, what is known, what is disputed, what to decide,
  and what to do next._
- **Waiting on a machine upstream.** A machine whose upstream machine is stale or
  running reads _ran · waiting on Distill_ (or _stale · …_), in the stale colour.
  While Distill runs, the lever reads _Waiting on Distill_ and is disabled.
- **Feeds drawn from machines.** A feed from a machine's tray is drawn from that
  machine's port, so a chain reads machine to machine.
- **Rerun the chain.** On a machine waiting on a stale machine, the lever reads
  _Rerun the chain ×2 · $…_. One press reruns every stale machine upstream, every
  machine between them and this one, and this one, in feeding order. Each is pressed
  only after the one before has finished its answer, and a run that does not finish
  stops the chain with a message. _Run this one only_ beneath the lever presses just
  this machine on what it is fed now.
- **Fewer reads.** Local changes and outbox acknowledgements now gather into one read
  of the brane 200 ms later, the brane list is read at most once a second, and a
  session confirmed in the last ten seconds is not asked for again before each edit.

### Decisions taken while building

| Question                                          | Decision                                                                                                                    | Rationale                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does _Feed from…_ live?                     | On each slot row, as a menu of machine names.                                                                               | The slot is where a feed lands; naming machines needs neither end in view, which is what the fit view in scenario 6 stood in for, and it works in Focus on a phone, which has no ports.      |
| Who runs a chain?                                 | The page: it presses each machine through the ordinary machine request, waits for the runs to finish, and presses the next. | Every press stays a press the server already admits, checks against the allowance and records; a server-side chain would need a queue of presses waiting on runs.                            |
| When is the next machine pressed?                 | When every run of the previous press has ended, read from run reports with a read every 3 s as a backstop.                  | The next machine is fed the previous one's new answer, which the server refuses as an input until it is final.                                                                               |
| What does the chain's estimate say?               | The sum of each machine's own estimate over what it is fed now; the lever refuses when the sum exceeds today's allowance.   | A downstream machine's new input does not exist before its upstream answers; each press is still held against the allowance at its own admission, so the chain stops rather than overspends. |
| Which machines does the chain rerun?              | Every machine upstream that is stale or running, or is fed by one that reruns, then this one.                               | A machine between two stale ones is not stale itself until its producer answers, but its answer will change.                                                                                 |
| What is the lever while an upstream machine runs? | _Waiting on Distill_, disabled; _Run this one only_ stays.                                                                  | Pressing now would answer from the answer about to be replaced; the escape remains for a reader who wants exactly that.                                                                      |
| Which feeds are drawn from a machine?             | A feed whose source is a machine's tray now: its newest card, or the stack it made.                                         | That feed follows the tray, so the machine is what it reads from; a feed from an older card the machine left is drawn from that card.                                                        |
| Which scenario holds the matrix?                  | Scenario 3; the recommendation's "scenario 4" was a slip, as scenario 4 is _Ask a region_.                                  | The concept's numbering is the reference for every measurement.                                                                                                                              |
| What does Brief take?                             | One slot, `{material}`, with a fixed five-part shape.                                                                       | An audience slot would cost a card and a feed in every chain that ends in a brief; the audience can be written into the prompt.                                                              |

### Measured

| Scenario                                    | Actions                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6. Sources into Distill into a Brief, built | 15 (drop, lasso, `G`, Stack, Add, Workshop, Distill, port, Run, Add, Workshop, Brief, _Feed from…_, Distill, Run), none typed, from 57 characters |
| 6. The same chain after a source is edited  | 2, from 3 (the edit, _Rerun the chain ×2_)                                                                                                        |
| 3. The matrix, then a Brief over it         | 22 to the matrix, unchanged, 188 characters typed; then 5 (Add, Workshop, Brief, the matrix's port, Run)                                          |

Scenario 6 needs no typing and no fit view, and keeping it current is one press after
the edit. The browser test also reruns the chain from Brief in Focus on a 320-pixel
phone, where nothing overflows. The Brief over the matrix reads all twelve answers in
one slot.

### Defects found by building it

- Scenario 3 with a Brief reached the account's limit of 240 requests a minute:
  every local change and every acknowledgement of one made the page read the brane,
  the budget and the brane list, and every edit sent from the outbox asked for the
  session first. Over the scenario the page made 219 requests before the Brief was
  even taken out; it now makes 125 with the Brief.
- A machine whose answers were split into cards read as stale once they arrived: its
  runs' sources are listed once for every card, so it compared more inputs than it
  had sent. Since iteration 10 this only coloured Split; with chains, Diagram fed from
  Split offered _Rerun the chain_ and reran Split. Staleness now reads the sources of
  the run's own output only.
- The tray handle that feed edges start from lay over the tray port and took its drags;
  it no longer takes the pointer. The port itself overlapped the end of the lever and
  now sits on the machine's edge.
- A machine waiting on a running machine asked for an estimate over an answer still
  being written, which the server refuses; it now waits.
- A drag started while a fitted view was still animating missed its target; the test's
  drag now waits for both ends to hold still.

## Iteration 14: chains kept current, and the table at scale

Iteration 14 let a machine be kept current, gave the last machine of a chain a receipt
for the chain behind its answer, let a chain be built on a phone, and measured the
table with dozens of answers on it.

- **Keep current.** A machine's back has a _Keep current_ box. A machine kept current
  that is stale, or waiting on a machine upstream, reads _due · waiting on Distill_ (or
  _due · material changed_). The brane's header then shows _Run all due ×N · $…_: one
  press runs every due machine with every machine its chain needs, in feeding order,
  each after the one before has finished. While a machine in it runs, the header reads
  _1 due · waiting on Distill_. Nothing runs without that press. The setting is stored
  with the brane (`kept_current`, migration 009) and goes through the offline outbox
  as `machine.keep`.
- **The chain behind an answer.** A machine's back lists, when another machine's answer
  was among its inputs, the press behind each answer its newest answer read, upstream
  first: the machine, its models, its runs and how they ended, and the settled cost,
  then a total.
- **Feed into…** A machine that has run offers _Feed into…_ beside its lever, listing
  every other machine's slot its answers could feed without a loop. It is the mirror of
  _Feed from…_, and it is how a chain is built on a phone, where machines have no ports.
- **The prompt version on an answer.** An answer's receipt names the prompt version its
  run read, and each earlier version on its back names its own, so a tuned prompt's
  answers can be compared by version.
- **Fewer reads while runs stream.** While three or more runs are under way, run reports
  gather into one read of the brane a second instead of one every 200 ms, and the day's
  allowance is read at most once in 1.5 s, with one more read at the end of a stream.

### Decisions taken while building

| Question                                          | Decision                                                                                                                              | Rationale                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Where is _Keep current_ stored?                   | With the brane, one row per machine placement, written through the outbox as `machine.keep`.                                          | It is a choice about this machine on this table, wanted on every device and offline; a page-only setting would forget it.                |
| When is a machine due?                            | When it is kept current and is stale or waiting on a machine upstream.                                                                | Kept current means its answer should match what it is fed and asked now; an edited prompt makes it due as surely as a rerun upstream.    |
| What does the machine's lever say when it is due? | What one press of it does, as before (_Rerun_, _Rerun the chain ×2_); the label above names it due.                                   | The lever states its own press; the header holds the press for everything due.                                                           |
| What does _Run all due_ run?                      | The union of the due machines' chains, in feeding order, one press each, waiting for each to finish; it waits while any of them runs. | The same rule as _Rerun the chain_, so a machine shared by two chains runs once.                                                         |
| What does the chain receipt list?                 | The press behind each answer the newest answer read, followed upstream; not the machines' newest presses.                             | The receipt explains this answer; a later upstream press that this answer did not read belongs to the next one.                          |
| Where is _Feed into…_?                            | In the machine's footer, on the canvas and in Focus.                                                                                  | Focus on a phone shows the machine's slots and lever and nothing else; the footer is where its answers leave from.                       |
| How often is the allowance read?                  | At most once in 1.5 s, with a trailing read.                                                                                          | It changes only when runs are admitted or settle; read on every refresh, it was a third of the page's requests during a press of twelve. |
| How long do busy run reports gather?              | One second while three or more runs are under way; 200 ms otherwise.                                                                  | A single run still lands at once; a press of twelve no longer reads the brane ten times.                                                 |
| How is frame time measured?                       | `requestAnimationFrame` intervals while the canvas is panned with space-drag across the fitted table, in headless Chromium.           | It is the one number the browser tests can repeat; it bounds the canvas's own work, not a slow machine's.                                |

### Measured

| Scenario                                                       | Result                                                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 6. Distill → Brief, built                                      | 15 actions, none typed, unchanged                                                                                                            |
| 6. After an edit, with Brief kept current                      | Once: ↻, _Keep current_, ↻ (3). Then each edit: the edit and _Run all due ×2_ (2)                                                            |
| 6. Built and run on a 320-pixel phone, machines already placed | 6 (Distill from the strip, Run, _Feed into…_, _Brief · material_, Brief from the strip, Run)                                                 |
| 7. Tune a prompt                                               | 3 (the prompt, Rerun, ↻), 56 characters typed; the receipt names the new prompt version and _Earlier version_ the old one                    |
| 3. The matrix, then a Brief over it                            | 22 and 5, unchanged                                                                                                                          |
| 1. Pressure-test a claim                                       | 7, unchanged                                                                                                                                 |
| 2 at scale: twelve papers through Split each and Diagram       | 15 actions; 24 ideas in 2.5 s from the press, the diagram in 1.6 s; at most 58 page requests a minute; frames 16.7 ms median, 16.8 ms worst  |
| 3 at scale: twelve papers, five questions, a 60-cell matrix    | 30 actions, 316 characters; each press of twelve 3.6 to 4.6 s; the matrix laid in 0.3 s; at most 186 page requests a minute; frames as above |

Scenario 7 runs for the first time and costs three actions. At sixty answers the canvas
holds 60 frames a second while panning and nothing crosses the 16 ms budget. The
request limit is the constraint that matters: the 60-cell matrix reached it before the
reads were gathered, and still spends 186 of its 240 a minute, most of them one save per
card when the matrix lays its 60 cards out.

### Defects found by building it

- Five presses of twelve runs reached the account's limit of 240 requests a minute:
  each press read the brane and the allowance about ten times, once per 200 ms of run
  reports. See the gathering above.
- The browser tests' own reads count against the same limit, and some polled every
  100 ms; they now poll at most twice a second.

## Recommended iteration 15

Fewer requests per gesture, and machines that say what they will cost before they are
built.

1. **One save for a layout.** Laying out a matrix, a diagram or a stack, and moving a
   lasso, saves every card's place in one outbox command (`placements.arrange`) instead
   of one per card. Measure the 60-cell matrix's requests a minute again; the aim is
   under 120.
2. **The cost of a chain before it is built.** _Feed from…_ and _Feed into…_ show what
   one press of the downstream machine would cost with the new input, and _Keep current_
   shows what a run of everything due would cost now.
3. **A due machine on the brane list.** The list of branes marks a brane with machines
   due, so a chain kept current is found without opening every brane.
4. **Large answers.** Scenario 2 with 24 papers through Split each (48 ideas, two presses
   of twelve) and a Diagram over them: whether 24 cards per answer and 200 per group
   hold, and how the diagram reads at that size.
5. Measure scenarios 3, 6 and 7 again, and scenario 8 (branch a conversation) for the
   first time.

## Iteration 15: one request for many saves, and costs before a chain is built

Iteration 15 sent the outbox's ready operations in one request, priced a feed before it
is made, marked branes with machines due on the list, ran 24 papers through two Splits
into one Diagram, and ran scenario 8 for the first time.

- **One request for many saves.** Operations ready within 20 ms go to the server in
  one request (`POST /sync/commands` with up to 100 operations, at most 256 KB), and
  each answers on its own. Laying out the sixty-cell matrix is one request instead of
  sixty. A lasso move, a stack and a diagram take the same path.
- **A feed priced before it is made.** Each option of _Feed from…_ and _Feed into…_
  reads _Distill · 1 run_ (and the cost, for a priced model): one press of the
  downstream machine as if the feed existed. A machine with another slot still empty
  reads _then feed {slot}_. The estimates are made when the menu opens.
- **Run all due, from a machine's back.** Under _Keep current_, a machine's back reads
  _Run all due now: 2 machines · $…_: what the header's press would run, were this
  machine kept current.
- **Machines due on the list of branes.** A brane with machines kept current that are
  due shows _1 due_ beside its title. The server counts it with the page's own staleness
  code, now in `shared/machine-staleness.ts`.
- **Large answers.** One run reads up to 64 cards, from 32. A machine fed past that, or
  a slot fed **each** past twelve cards, says so on its lever before the press. A
  diagram's layer wraps at a square grid's width.
- **A reply's thread.** A run that continues a conversation names the answer it
  continues, and the canvas draws a dotted _reply_ line from that answer to the reply.

### Decisions taken while building

| Question                                            | Decision                                                                                                                       | Rationale                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One `placements.arrange` command, or batched sends? | Batched sends: the outbox sends every ready operation in one request; no new command kind.                                     | It covers every burst (layouts, lasso moves, duplicates) at once, and each operation keeps its own key, conflict review and dependencies. A deviation from the recommendation. |
| How long does an operation wait for others?         | 20 ms, or until 100 operations or 256 KB are gathered.                                                                         | Far below what a user notices; well inside the server's request size.                                                                                                          |
| Does one refused operation fail the request?        | No. Each is applied in its own transaction and answers with its key or its refusal; a whole-request failure leaves all queued. | A guest limit on one card must not undo the cards before it or pause the ones after.                                                                                           |
| When is a feed option priced?                       | When its menu opens, one estimate per option.                                                                                  | A closed menu costs nothing; an open one is about to be chosen from.                                                                                                           |
| How is a feed not yet made priced?                  | The page builds the downstream machine's request from the brane as if the feed existed; the server estimates it as any press.  | The server already prices explicit inputs; no hypothetical feeds are stored or sent.                                                                                           |
| What does _Keep current_ price?                     | What _Run all due_ would press now with this machine kept current.                                                             | It answers the question the box raises: what keeping it costs at the next press.                                                                                               |
| Where is a brane's due count computed?              | On the server, with the page's staleness code moved to `shared/`; only branes with a machine kept current are read.            | A brane not opened on this device has no projection on the page; the server has every brane.                                                                                   |
| When is the list read again?                        | On a local change, two seconds after the last answer finishes, and every 30 s for other devices' changes.                      | Read on every finished answer, it spent 25 of the matrix's busiest minute.                                                                                                     |
| How many cards may one run read?                    | 64 (`MAX_RUN_INPUTS`), and the lever says so past it.                                                                          | The context allowance already bounds what the cards hold; two Splits' 48 ideas fit easily.                                                                                     |
| How does a diagram of 24 cards lie?                 | Each layer in rows of at most ⌈√n⌉ cards, layers still top to bottom.                                                          | One row per layer laid 23 supporting ideas 9,620 wide; wrapped, the diagram is 2,060 by 2,000.                                                                                 |
| How does a reply show what it continues?            | A dotted _reply_ line from the continued answer, read from the run's context.                                                  | It is the thread line the concept names, and it needs no stored relation.                                                                                                      |

### Measured

| Scenario                                                    | Result                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3 at scale: twelve papers, five questions, a 60-cell matrix | 30 actions, 316 characters; each press of twelve 3.6 to 4.6 s; the matrix laid in 0.4 s; at most 116 page requests a minute alone (115 to 126 under load), from 186; frames 16.7 ms             |
| The matrix's busiest minute, by path                        | 47 brane reads, 21 sync requests, 17 allowance reads, 14 list reads, 5 presses, 5 estimates, 4 session reads                                                                                    |
| 2 at scale: 24 papers, two Splits of twelve, one Diagram    | 25 actions; 48 ideas, each press in 1.5 to 2.5 s; the diagram in 5.6 s; the answer lists 48 items, 24 became cards with 23 arrows, 2,060 by 2,000; at most 77 requests a minute; frames 16.7 ms |
| 2 at scale: twelve papers                                   | 15 actions; at most 49 requests a minute, from 58                                                                                                                                               |
| 3. The matrix, then a Brief over it                         | 22 and 5, unchanged                                                                                                                                                                             |
| 6. Distill → Brief, built; after an edit; kept current      | 15, 2 and 5, unchanged; the option reads _Distill · 1 run_ before the feed is made                                                                                                              |
| 6. Built and run on a 320-pixel phone                       | 6, unchanged; the option reads _Write a brief from · material · 1 run_                                                                                                                          |
| 7. Tune a prompt                                            | 3 actions, 56 characters, unchanged                                                                                                                                                             |
| 8. Branch a conversation (first time)                       | 12 actions, 91 characters: the question (4), then per reply select, _Reply_, the follow-up, Run (4 each); the first reply lies beneath, the second beside; both joined by a _reply_ line        |

Scenario 8 runs for the first time in twelve actions; four of them are the first
question. The sixty-cell matrix meets the aim of 120 requests a minute on a quiet
machine and misses it by six under the full suite's load: the saves are now 21 of the
minute, and the rest is reads, chiefly the brane read after each gather of run reports.

### Defects found by building it

- A Diagram fed two Splits' 48 ideas was refused after the press with _Invalid request_:
  one run read at most 32 cards, and nothing said so before. See the bound above.
- A diagram's layer was one row: 23 cards supporting one idea lay 9,620 wide, wider
  than the fitted view.
- The mock model listed at most 8 items, so the 24-card answer bound was never reached
  in a test; it now lists up to 60.
- Two replies to one answer stood on the table with nothing joining them to it.
- The first version of the due marker read the list on every finished answer; see the
  list reads above.
- `canvas.browser.ts` (view switching) once lost the Context button's focus after
  Escape under the full suite's load; alone it passes twelve times of twelve.

## Recommended iteration 16

Fewer reads, and the last scenario.

1. **Quote to card (scenario 9).** In a PDF or webpage card, select a passage and press
   `Q`: an authored card with the passage appears beside it, citing the page (and the
   PDF page number), and feeds like any card. It is the one scenario never run; build it
   and measure it in a browser journey, including at 320 pixels.
2. **Read the brane less while runs stream.** The matrix's busiest minute is 47 brane
   reads. Send the changed runs, parts and placements with each run report (or one
   change set per gather), and read the whole brane only on reconnect. The aim: under
   90 requests a minute for the sixty-cell matrix under the full suite's load, with the
   busiest minute recorded by path.
3. **Count due on the page for the open brane.** The page already projects staleness:
   let the list's count for the open brane come from it, and stop reading the list on
   local changes that cannot change a title or a count (the 14 list reads).
4. **Say what a large answer kept.** A diagram or a stack cut at 24 cards says so on its
   frame (_24 of 48 ideas_), with the rest still in the whole answer on its back.
5. **Branches beneath their answer.** A second reply to one answer lies beneath it,
   beside the first reply, rather than level with the answer, so a conversation reads
   top to bottom.
6. Measure scenarios 4, 5 and 8 again.
