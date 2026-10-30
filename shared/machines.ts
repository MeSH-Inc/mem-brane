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
export const MAX_SLOT_NAME = 40;
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
