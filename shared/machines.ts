import type { BraneState, Feed } from './types/domain.js';
import { z } from 'zod';
import { id, edit } from './schemas/index.js';
import { MAX_BLOCK_TEXT_CHARACTERS } from './limits.js';

// A machine's template names its slots in braces: "Critique {claim} using {evidence}".
// Slots are derived from the template wherever it is read, so the prompt is the only
// authority over which inputs a machine takes and in what order.
export const MAX_MACHINE_SLOTS = 8;
// A new machine starts as a working Critique so its slots and lever are visible at once.
export const MACHINE_TEMPLATE =
  'Find the strongest objection to {claim}, using only {evidence}. Answer in three sentences, then name the one fact that would settle it.';
// A machine made from a selection starts with one slot holding every selected card.
export const SELECTION_MACHINE_TEMPLATE = 'Summarise {cards} in five sentences.';
export const MAX_SLOT_NAME = 40;
// One press of a slot fed 'each' admits at most this many runs.
export const MAX_EACH_RUNS = 12;
// One press compares at most this many models, one run each.
export const MAX_COMPARED_MODELS = 4;
// The Workshop's built-in machines. Taking one out places a machine with its prompt.
export const BUILT_IN_MACHINES = [
  { name: 'Critique', template: MACHINE_TEMPLATE },
  {
    name: 'Distill',
    template:
      'Distill {material} into one card: the main claims, where they agree, and where they conflict.',
  },
  {
    name: 'Split',
    template:
      'Split {text} into its separate ideas. Write each as a numbered line ("1. …"), one self-contained sentence, with nothing before or after the list.\nOutput: cards',
  },
  {
    name: 'Diagram',
    template:
      'Diagram {material}. First list its main ideas as numbered lines ("1. …"), one short sentence each. Then list how they relate, one line per relation, written as "2 —supports→ 1" with a one- or two-word verb. A relation joins two different ideas; leave an idea that relates to none without one.\nOutput: diagram',
  },
  {
    name: 'Extract',
    template: 'From {source}, answer in one short sentence: what is its main finding?',
  },
] as const;
export const MAX_WORKSHOP_NAME = 60;
export const machineTemplate = z.string().min(1).max(MAX_BLOCK_TEXT_CHARACTERS);
const slotPattern = /\{([^{}\n]{1,40})\}/g;

export function machineSlots(template: string): string[] {
  const slots: string[] = [];
  for (const match of template.matchAll(slotPattern)) {
    const name = match[1].trim();
    if (name && !slots.includes(name)) slots.push(name);
  }
  return slots.slice(0, MAX_MACHINE_SLOTS);
}

export const slotName = z.string().trim().min(1).max(MAX_SLOT_NAME);

// A machine run names its inputs explicitly, in slot order then feed order. Feeds are
// the interface's record of these choices; the run freezes what was sent.
export const runMachine = z
  .object({
    braneId: id,
    key: id,
    machinePlacementId: id,
    model: z.string().min(1).max(100),
    inputs: z
      .array(z.object({ blockId: id, slot: slotName }).strict())
      .min(1)
      .max(32),
    edits: z.array(edit).max(33).default([]),
    // The slot fed 'each': one run per card in it, all admitted by this one press.
    each: z.string().trim().min(1).max(40).optional(),
    // Compare models: one run per model over the same inputs, all admitted by this press.
    // Each and a comparison are not combined.
    models: z
      .array(z.string().min(1).max(100))
      .min(2)
      .max(MAX_COMPARED_MODELS)
      .refine((models) => new Set(models).size === models.length, 'A model is compared once.')
      .optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    maxReservedMicrousd: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
export type RunMachine = z.infer<typeof runMachine>;
export type RunMachineRequest = z.input<typeof runMachine>;

export interface MachineInput {
  blockId: string;
  slot: string;
}

// Order inputs by the template's slot order, keeping feed order within a slot.
export function orderMachineInputs<T extends MachineInput>(template: string, inputs: T[]): T[] {
  const slots = machineSlots(template);
  return slots.flatMap((slot) => inputs.filter((input) => input.slot === slot));
}

// A machine is called by its prompt's words before its first slot ("Split" from
// "Split {text} into…"), else by the prompt's first 60 characters.
export function machineName(template: string) {
  return (
    template
      .split('{')[0]
      .trim()
      .replace(/[\s,:;]+$/, '')
      .slice(0, 60) || template.trim().slice(0, 60)
  );
}

// Feeds join machines into an acyclic graph: a machine feeds another when a card or
// group it produced fills one of the other's slots. A new feed from cards the given
// machines produced into the consumer closes a loop when the consumer is one of those
// producers, or feeds one of them through other feeds.
export interface MachineEdge {
  producer: string;
  consumer: string;
}
export function closesLoop(edges: MachineEdge[], producers: string[], consumer: string) {
  const downstream = new Set([consumer]);
  const pending = [consumer];
  while (pending.length) {
    const machine = pending.pop()!;
    for (const edge of edges)
      if (edge.producer === machine && !downstream.has(edge.consumer)) {
        downstream.add(edge.consumer);
        pending.push(edge.consumer);
      }
  }
  return producers.some((producer) => downstream.has(producer));
}

// The machines whose outputs feed each machine: a feed from a card a machine produced,
// or from a group holding one, joins the two.
function machineEdges(
  state: Pick<BraneState, 'placements' | 'groups' | 'feeds' | 'runs' | 'parts' | 'derivations'>,
) {
  const anchor = new Map<string, string>();
  for (const d of state.derivations)
    if (d.anchorPlacementId) anchor.set(d.runId, d.anchorPlacementId);
  const producerOf = new Map<string, string>();
  for (const run of state.runs)
    if (anchor.has(run.id)) producerOf.set(run.output_block_id, anchor.get(run.id)!);
  for (const part of state.parts)
    if (anchor.has(part.runId)) producerOf.set(part.blockId, anchor.get(part.runId)!);
  const blockOf = new Map(state.placements.map((p) => [p.id, p.block_id]));
  return {
    edges: state.feeds.flatMap((feed) =>
      sourceMembers(state, feed).flatMap((id) => {
        const producer = producerOf.get(blockOf.get(id) ?? '');
        return producer ? [{ producer, consumer: feed.to_placement_id }] : [];
      }),
    ),
    producers: (source: { placementId: string } | { groupId: string }) =>
      sourceMembers(state, {
        from_placement_id: 'placementId' in source ? source.placementId : null,
        from_group_id: 'groupId' in source ? source.groupId : null,
      }).flatMap((id) => producerOf.get(blockOf.get(id) ?? '') ?? []),
  };
}
function sourceMembers(
  state: Pick<BraneState, 'groups'>,
  feed: Pick<Feed, 'from_placement_id' | 'from_group_id'>,
) {
  return feed.from_group_id
    ? (state.groups.find((g) => g.id === feed.from_group_id)?.members ?? [])
    : [feed.from_placement_id!];
}

// Whether a feed from this source into this machine would close a loop.
export function feedClosesLoop(
  state: Pick<BraneState, 'placements' | 'groups' | 'feeds' | 'runs' | 'parts' | 'derivations'>,
  source: { placementId: string } | { groupId: string },
  consumer: string,
) {
  const { edges, producers } = machineEdges(state);
  return closesLoop(edges, producers(source), consumer);
}
export const LOOP_REFUSAL = 'This feed would close a loop: the machine would feed its own input.';
