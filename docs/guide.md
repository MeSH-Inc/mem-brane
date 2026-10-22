# Using mem-brane

## First steps

1. Open the seeded brane or choose **New brane**.
2. In Canvas, double-click empty space to create a thought and type into its editor. In Focus, choose **Add → Text** instead.
3. Choose **Develop** on a card to create a response from it. Develop captures the card's current text and records provenance; it does not read the prompt or inherit a conversation automatically.
4. To compose, choose **Use as context** on cards (or select them and choose **+ Add N selected**), order them under **Context · N**, write a prompt and Run. The response's **Based on** strip links to its sources and exact inputs, and marks sources edited since. **⑂ Continue** on a response explicitly selects its conversation's ancestor chain.
5. An empty brane lists these steps. Titles, text and placement changes save automatically. The composer shows saving status; failed title writes retain the draft and offer Retry. Background runs continue when you navigate away.

The mock model exercises streaming and persistence but does not perform reasoning or image understanding.

## Import images and PDFs

Paste a screenshot, drop files onto the canvas, or choose **Add → Image / PDF**. The **+** button in the prompt attaches files as explicit context. Text paste keeps normal editor behavior. Pending imports show previews, survive navigation and can be recovered after reload; Retry reuses the original import identity.

PNG, JPEG, GIF, WebP and PDF files are supported, up to 5 MiB by default. Original files are retained. PDFs expose extracted text by page and work as text context with every configured model. Scanned PDFs without a text layer are kept but are not usable as context. Embedded images are not sent as model context. Documents beyond extraction limits remain downloadable without sending partial text. Animated images are stored but require a still image for model context.

## Canvas and Focus

Brane navigation collapses from the upper-left menu. **Context · N** beside the prompt opens reference ordering; **History** lists this brane's responses, with Stop and Retry; earlier responses whose cards were removed load on request. Both open as dialogs without resizing the workspace. A response's **Exact inputs** (from History or its **Based on** strip) opens at its own address, `/b/:braneId?inputs=:runId`, showing the frozen inputs, cost and a link to the response. Back, Close and Escape return to where it was opened. The link works for anyone signed in to the same account. Running and failed generations remain accessible from the activity row. Card actions appear on selection, hover or keyboard focus, and stay visible on touch screens. A card's **More** menu shows it on another brane, opens its version history, or removes it from this brane while keeping its history.

Removing a card preserves its content and history. **Add → Unplaced cards** lists cards in the current library with no remaining placement, with paginated summaries, full previews and **Show here**. Restoration keeps the original identity, file bytes and provenance. A removed response can also be previewed and shown again from History's **Exact inputs**. If a card still appears on another brane, use its **Show on another brane** action there. Reusing a response's inputs requires all its sources to be on the current brane; missing sources are reported and your unfinished prompt is kept.

The canvas has no tool modes:

| Gesture                                         | Effect                                                     |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Drag empty canvas                               | Select cards intersecting the marquee                      |
| Double-click empty canvas                       | Create a thought                                           |
| Drag a card header                              | Move the card, or the selected group if it is selected     |
| Shift-click a header                            | Toggle that placement in the selection                     |
| Space-drag, middle/right drag, one-finger touch | Pan the viewport, including from a card header             |
| Arrow keys / Alt+Arrow keys                     | Nudge / resize the selected cards (Shift for larger steps) |

Use Fit View to find offscreen cards. Editor text gestures do not move cards. Escape, blur and pointer cancellation abort selection, movement and resizing without saving; cancellation restores the previous selection. Wheel gestures pan; Control/Command-wheel zooms around the pointer.

Selection belongs to placements: two instances of the same block can be selected independently. When cards are selected, the prompt offers **+ Add N selected**, which resolves the selection to unique blocks. Responses offer **⑂ Continue** to branch their conversation. Selection, proximity, movement and resizing never invoke a model or implicitly change context.

Mobile defaults to **Focus**, with a full-width editor, horizontal block outline, tap-to-add, image picker and brane navigation. Canvas is an optional overview, with touch viewport panning. Canvas rendering is lazy. In production, PWA installation also precaches Canvas code and styles in the background so it can open offline. A focused link has the form `/b/:braneId?focus=:blockId&view=focus`.
