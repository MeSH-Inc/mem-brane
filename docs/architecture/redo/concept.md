# Concept

## Card

A card is a placed block, as today. What changes is that every card has two faces.

**Front: the thing.** Text, an image, a PDF, a webpage, or a generated response. At
rest a card shows only its content and, in one corner, a count of what is on its
back (`3`). No action row.

**Back: how it came to be, and what came of it.** Flip a card (`F`, the folded corner,
or the count) and it turns over in place. A flipped card rises above its neighbours
and keeps a strip of its front visible, so your own text never seems to vanish.

| Card origin | Back shows                                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authored    | **Developments**: every output that used this card as a source or reference, newest first. Edit history below.                                                                                                                                                             |
| Generated   | **Receipt**: the machine and its revision, each frozen input by slot, the relations sent, the earlier conversation if it was a reply, model and cost. Each item is marked if edited since. Then **Earlier versions** (what this output replaced) and its own developments. |

The back replaces the current **Based on** strip, **Exact inputs** page, per-card
history and much of the **History** dialog: the same information, kept with the object
it describes.

## The output rule

**An output attaches to what you ran.**

| You ran           | The output appears                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Develop on a card | On that card's back; the card flips to show it                                                          |
| A machine         | In the machine's tray, to its right; a rerun replaces it and keeps the old one on the new output's back |
| A loose Ask (`/`) | Where the Ask was: the Ask collapses into its answer, and the question moves to the answer's back       |

Outputs on a back are one gesture from the table: **Put on table** (or drag) gives
the output a placement with an arrow from its source. Nothing generated is ever lost;
the table holds only what you chose to keep in view.

_Decision: Develop writes to the back._ Today every Develop adds a card to the canvas,
and the canvas fills with responses that were glanced at once.

_Decision: Ask collapses._ A loose prompt that stayed on the table as a machine would
leave one machine per question, which is the clutter this redo removes. **Make
reusable** on the answer turns the Ask back into a machine with its feeds.

## Machine

A machine is a card whose content is a prompt with named slots:

```text
Find the strongest objection to {claim}, using only {evidence}.
Answer in three sentences, then name the single fact that would settle it.
```

Each `{name}` becomes a **slot**: a row inside the machine with a port on its left
edge, showing how many cards feed it. The right edge is the **tray**. Under the slots
is the **lever**, one button whose label is the next run's estimate
(`Run · ≈ $0.004`), its blocker (`Feed evidence`, `Over today's allowance`), or
`Rerun` when the machine is stale.

**A slot takes any number of cards.** They are sent in feed order, numbered on the
slot row. Feeding a group feeds its members in reading order. Whenever both ends of an
arrow are inputs to the same run, the arrow is sent too, as a relation
(`New station —causes→ Shorter commutes`).

**Each.** When a stack or group feeds a slot, the slot row shows a toggle:
**together** (default: all members in one run) or **each** (one run per member;
outputs arrive as a matching stack). The lever shows the total (`Run ×24 · ≈ $0.09`).
Fanning out multiplies cost, so it is never inferred.

**The back of a machine** holds its revision number, its past runs, and **Compare
models**: tick several models and the next pull produces one output per model, side
by side. The choice applies to that run only.

**Machines are reusable.** The **Workshop** drawer holds built-in machines and any
machine saved with **Save to Workshop**. Taking one out places a copy, so editing a
prompt on one brane never changes another.

Built-in machines:

| Machine  | Slots                   | Output                                                                                       |
| -------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| Develop  | `{source}`              | One card on the source's back. Bound to `D`.                                                 |
| Critique | `{claim}`, `{evidence}` | The strongest objection and the fact that would settle it.                                   |
| Split    | `{text}`                | A stack, one card per idea.                                                                  |
| Distill  | `{material}`            | One card summarising everything fed.                                                         |
| Diagram  | `{material}`            | A region of cards joined by labelled arrows.                                                 |
| Extract  | `{source}`              | A short answer to the question written in its prompt; with **each**, one column of a matrix. |

## Ask and Reply

Press `/`. What happens depends on the selection:

| Selection    | `/` creates                                     |
| ------------ | ----------------------------------------------- |
| Nothing      | An Ask at the pointer with an empty slot        |
| Cards        | An Ask beside them, already fed by them         |
| One response | A **Reply** beneath it, joined by a thread line |

Type, press `Enter`. An Ask on one card with an empty question is Develop.

A **Reply** continues the conversation: the model receives the earlier exchange as
conversation, not as attached material. Its thread line is not a link you can draw or
redirect; it records the parent message, as today's **Continue** does. To use a
response as plain material instead, draw a feed from it.

## Link

A link is a line you draw from one thing's edge to another. Its meaning depends on
where it ends:

| Ends on        | Kind      | Drawn as                     | Meaning                                                       |
| -------------- | --------- | ---------------------------- | ------------------------------------------------------------- |
| A machine slot | **Feed**  | Solid, into a slot port      | This is that slot's input.                                    |
| A card         | **Arrow** | Thin, with an editable label | A relation you assert: _causes_, _contradicts_, _example of_. |

Feeds are the visual programming. Arrows are the diagramming. One gesture draws both,
so nobody chooses a tool before drawing a line. A machine's tray can feed another
machine's slot; a feed that would close a loop is refused as you draw it.

## Staleness and Update

When a run's inputs would differ if it were run now (a fed card edited, a card added
to a fed group, an arrow relabelled, the machine's prompt edited), the machine is
**stale**. Its changed feeds turn amber and dashed. Each of its outputs shows an
**Update** button with the estimate.

Update reruns one machine. When its new output feeds another machine, that machine
becomes stale in turn and shows its own Update with its own estimate. A chain is
updated one press per machine.

_Decision: one machine per press._ Running a whole chain at once cannot be estimated
honestly (how many cards Split produces is unknown until it runs) and would freeze
inputs after admission. One press per layer keeps each estimate exact and each freeze
at the moment of the press.

## Groups

Lasso cards and press `G`: they become a **group**, a labelled set that moves as one
and can be fed as one. Its display is presentation only:

| Display | Looks like                                                                |
| ------- | ------------------------------------------------------------------------- |
| Region  | A dashed area with the cards laid out inside                              |
| Stack   | A fanned pile taking one card's space                                     |
| Matrix  | Rows are source cards, columns are the machines fed by them with **each** |

Changing the display never changes what a machine receives. A group holds cards, not
other groups.

## Focus and phone

Double-click a card's front to open it full screen for reading and writing, with its
back as a side sheet. This replaces the Canvas/Focus switch on desktop. Phones keep
today's Focus view; on a phone a machine shows as a form whose slots are card
pickers, and feeds and arrows are listed rather than drawn.

## Things people would actually do

Each step names the visible cue it depends on.

1. **Pressure-test a claim.** Write a claim; the chip row offers _Develop_. Press `D`:
   the card flips to its development. Select the claim and the study card; the chip
   row offers _Critique_. Press it: a Critique machine appears beside them with the
   claim in `{claim}` and the study in `{evidence}`. Pull the lever. Drag the
   objection next to the claim and draw an arrow labelled _answers_.
2. **Turn a reading pile into a map.** Drop twelve PDFs, lasso them, press `G`, press
   _Stack_. Feed the stack to Split and switch the slot to **each** (the lever reads
   `Run ×12`). Lasso the resulting cards, feed them to Diagram: a region of cards and
   labelled arrows arrives. Rearrange it; it is now your diagram.
3. **Build a literature matrix.** Feed the PDF stack into three Extract machines
   (_method_, _sample size_, _main finding_), each set to **each**. Lasso the outputs,
   press `G`, choose _Matrix_: one row per paper, one column per question.
4. **Ask a region.** Lasso a corner of the table; the chip row offers _Ask about 9_.
   Type the question. The answer appears where the Ask was; its back lists exactly the
   cards and arrows that were sent.
5. **Pick a model by looking.** On a machine's back, tick three models. One pull
   produces three outputs side by side. Keep one on the table; the others stay on the
   back.
6. **Keep a living brief.** Feed five source cards into a _Brief_ machine. A week later
   you edit two of them: the feeds turn amber and the brief shows _Update · ≈ $0.006_.
   Press it; last week's version is on the new brief's back under _Earlier versions_.
7. **Tune a prompt.** Edit a machine's prompt (double-click it). Its outputs go stale.
   Update, then flip the output: the receipt says _r3_ and _Earlier versions_ holds the
   _r2_ answer for comparison.
8. **Branch a conversation.** Select a response; the chip row offers _Reply_. Ask a
   follow-up: it appears beneath, on a thread line. Select an earlier response and
   reply again to branch; both branches stay on the table.
9. **Quote to card.** In a PDF or webpage card, select a passage and press `Q`: a card
   with that passage appears beside it, citing the page. Quotes are ordinary authored
   cards and feed like any other.
