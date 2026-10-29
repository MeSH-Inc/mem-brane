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

## Recommended iteration 3

Prototype the feed-and-slot model inside the real canvas behind a route flag, and
measure one thing against the current composer: the time and the number of actions
needed to complete scenarios 1, 4 and 6 with the local mock model. Concretely:

1. Add the `machine` block kind and the `slot` column on manifest entries
   (migration, schema in `shared/`, worker template substitution in `server/llm/`).
2. Add the Feed record with cycle rejection, and project staleness by calling
   `run-plan.ts` per visible machine.
3. Render machines, feeds and the lever in `src/canvas/`, and the receipt on the card
   back from the existing Exact inputs data.
4. Write one Playwright scenario per measured task, and record action counts for both
   interfaces in this file.
