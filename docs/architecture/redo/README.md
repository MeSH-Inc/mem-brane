# Redo: a table of cards and machines

Status: concept, iteration 2. Nothing here is implemented. This directory proposes a
replacement for the current brane interface; once accepted, its decisions move into the
numbered architecture documents and this directory is removed.

## Thesis

The current interface shows every capability at once: a synchronization banner, a
title bar, a hint row, three actions on every card, a context row, a composer, a model
picker and a status line. All of it is correct, and together it reads as a form
attached to a canvas.

The redo has one surface, the **table**, and three things on it:

| Noun        | What it is                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| **Card**    | Content with two faces. The front is the thing; the back is where it came from and what came of it.              |
| **Machine** | A prompt you can reuse. Named input slots on the left, an output tray on the right, one lever.                   |
| **Link**    | A line between two things. Into a machine slot it is a _feed_ (input); between cards it is an _arrow_ (meaning). |

Groups (a region, a stack or a matrix of cards) are a way of holding several cards,
not a fourth noun: feeding a group feeds its members, and its display never changes
what a model receives.

Everything else the current interface shows becomes a property of one of these
objects, a chip shown for the current selection, or an entry in one command palette.

## The rules

- **An output attaches to what you ran**: Develop to the card's back, a machine to
  its tray, an Ask collapses into its answer.
- Only a press spends money, and one press runs one machine. Links, moves, groups and
  edits never run anything.
- Every output keeps its frozen inputs, and its back shows them.
- An edit that would change a run's inputs marks it **stale** and offers **Update**;
  nothing regenerates by itself.
- **Reply** continues a conversation; a **feed** attaches material. They stay
  structurally different, as today's Continue and Use as context are.

## Documents

| Document                    | Covers                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------- |
| [Concept](concept.md)       | The objects, their verbs, and nine things people would actually do                      |
| [Screen](screen.md)         | What is on screen at rest, what appears on demand, and the fate of each current control |
| [Domain mapping](domain.md) | How the objects map onto Block, Placement, Run and manifests; principle changes         |
| [Iterations](iterations.md) | Each revision of this concept, the critique that drove it, and the decisions taken      |
| [Mockup](mockup/index.html) | A clickable, dependency-free sketch of flip, machines, feeds and staleness              |

Open the mockup directly in a browser; it has no build step and makes no network calls.
