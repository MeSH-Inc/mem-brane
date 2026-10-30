import { z } from 'zod';
import { id, geometry, edit, placementEdit } from './schemas/index.js';
import { slotName, machineTemplate } from './machines.js';

const title = z.string().trim().min(1).max(200);
export const workspaceCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('brane.create'), id, title }).strict(),
  z.object({ type: z.literal('brane.title'), id, title, previous: z.string() }).strict(),
  z
    .object({
      type: z.literal('block.create'),
      kind: z.enum(['text', 'machine']),
      braneId: id,
      blockId: id,
      placementId: id,
      geometry,
      // A machine's starting prompt, the built-in Critique when absent; text ignores it.
      template: machineTemplate.optional(),
    })
    .strict(),
  z.object({ type: z.literal('text.edit'), ...edit.shape }).strict(),
  z
    .object({ type: z.literal('placement.create'), id, braneId: id, blockId: id, geometry })
    .strict(),
  z.object({ type: z.literal('placement.edit'), id, ...placementEdit.shape }).strict(),
  z
    .object({
      type: z.literal('placement.remove'),
      id,
      braneId: id,
      version: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('placement.detach'),
      id,
      braneId: id,
      // The back it leaves; removing that host must wait for this command.
      hostPlacementId: id,
      version: z.number().int().nonnegative(),
      geometry,
    })
    .strict(),
  z
    .object({
      type: z.literal('feed.create'),
      id,
      braneId: id,
      fromPlacementId: id,
      toPlacementId: id,
      slot: slotName,
    })
    .strict(),
  z.object({ type: z.literal('feed.remove'), id, braneId: id }).strict(),
]);
export const workspaceOperation = z.object({ key: id, command: workspaceCommand }).strict();
export const workspaceAcknowledgement = z.object({ key: id }).strict();
export type WorkspaceCommand = z.infer<typeof workspaceCommand>;
export type WorkspaceOperation = z.infer<typeof workspaceOperation>;
export function commandEntity(command: WorkspaceCommand): string {
  switch (command.type) {
    case 'block.create':
    case 'text.edit':
      return `block:${command.blockId}`;
    case 'feed.create':
    case 'feed.remove':
      return `feed:${command.id}`;
    case 'brane.create':
    case 'brane.title':
      return `brane:${command.id}`;
    default:
      return `placement:${command.id}`;
  }
}
