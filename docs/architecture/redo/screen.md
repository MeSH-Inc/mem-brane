# Screen

## At rest

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ ≡ Transit and rent                                                  ●    │  brane name; activity pip
│                                                                          │
│   ┌───────────┐            ┌──────────────────┐                          │
│   │ claim   2 │━━━━━━━━━━━▶● claim · 1 fed    │   ┌───────────────┐      │
│   └───────────┘            │   Critique       ▮━━▶│ objection     │      │
│   ┌───────────┐            ● evidence · 1 fed │   │ Update ≈$.004 │      │
│   │ study     │┅┅┅┅┅┅┅┅┅┅┅▶│ [Rerun · ≈$.004] │   └───────────────┘      │
│   └───────────┘   (amber)  └──────────────────┘                          │
│                                                                          │
│               [ Develop D ] [ Ask / ] [ Critique ] [ Flip F ] [ More ]   │  chips, only with a selection
│                     ┌──────────────────────────┐                         │
│                     │  /  Ask or do anything…  │  +  ⚒                  │  dock
│                     └──────────────────────────┘                         │
└──────────────────────────────────────────────────────────────────────────┘
```

Four things are permanent: the brane name, the activity pip, the table and the dock.

- **Brane name** opens brane navigation and the brane's settings, including its
  default model.
- **Dock**: the palette field, **+** (text, image, PDF, webpage, unplaced cards) and
  **⚒** (the Workshop).
- **Activity pip**: grey when idle and saved; pulsing while runs or synchronization
  are in progress; hollow while offline; amber only when something needs your choice
  (a conflict, a refused run). It opens the activity sheet: runs with Stop and Retry,
  today's spend against the allowance, and synchronization with the conflict choices.
  A banner appears only when a choice is required to avoid losing work.

## With a selection

A row of three to five **chips** appears above the dock, chosen for what is selected:

| Selected          | Chips                                           |
| ----------------- | ----------------------------------------------- |
| One authored card | Develop, Ask, Critique, Flip, More              |
| One response      | Update (when stale), Reply, Develop, Flip, More |
| Several cards     | Ask about N, Critique, Group, Flip, More        |
| A machine         | Run, Flip, More                                 |

Chips are how a new user finds the main verbs without hovering. Each shows its key,
so the keys are learned by use. **More** opens the palette.

The selected card's link handle stays visible while it is selected, so drawing a
feed or arrow does not depend on hover and works by touch.

## On demand

| Trigger                                    | Appears                                           |
| ------------------------------------------ | ------------------------------------------------- |
| `Space`, the palette field, or right-click | The palette, filtered to the selection            |
| `/`                                        | Ask, or Reply on a response                       |
| `F`, the folded corner, or the count       | The card's back                                   |
| Double-click a card                        | Edit in place; on a machine, edit its prompt      |
| Empty table                                | One line: _Double-click to write, or drop files._ |

Every command lives in the palette, which lists its key. The palette holds the long
tail: Group, Put on table, Make reusable, Save to Workshop, Show on another brane,
Version history, Fit, Remove.

## What happens to each current control

| Current control                             | In the redo                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Synchronization banner                      | Activity pip; a banner only when a choice is required                                                    |
| Title bar: Add, Canvas/Focus, History       | Brane name only; Add in the dock; Focus by double-click; History in the activity sheet and on card backs |
| Hint row                                    | Removed; chips and the palette show keys                                                                 |
| Card header icon and kind label             | A kind glyph in the corner, only for non-text cards                                                      |
| Card actions: Develop, Use as context, More | Chips and palette; Use as context becomes a feed or a selection before `/`                               |
| Context · N row and ordering dialog         | Feeds; order is feed order on the slot row                                                               |
| + Add N selected                            | _Ask about N_ chip                                                                                       |
| Composer, attach button, Run                | Ask (`/`); drop files onto a slot to attach                                                              |
| Model picker under the composer             | Brane settings (default) and **Compare models** on a machine's back (one run)                            |
| Saving status line                          | Activity pip                                                                                             |
| Based on strip                              | Feed lines and source lines on the table; the receipt on the back                                        |
| Exact inputs page                           | The receipt; it keeps its own address for sharing                                                        |
| ⑂ Continue                                  | Reply                                                                                                    |
| Derivation connectors                       | Feeds and source lines                                                                                   |
| Zoom buttons and React Flow attribution     | Gestures and **Fit** in the palette; attribution in the activity sheet footer                            |
| First steps panel                           | Removed; a new account's first brane has two cards and a Critique machine already fed                    |
| Run refusal notice beside Run               | The lever's own label, with the action in its menu                                                       |
