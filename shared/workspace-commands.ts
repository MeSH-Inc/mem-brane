import { z } from 'zod';
import { id, geometry, edit, placementEdit } from './schemas/index.js';
import { slotName, machineTemplate } from './machines.js';
import { relationLabel } from './relations.js';
import { groupLabel, groupDisplay, MAX_GROUP_MEMBERS } from './groups.js';

const title = z.string().trim().min(1).max(200);
const members = z
  .array(id)
  .min(1)
  .max(MAX_GROUP_MEMBERS)
  .refine((ids) => new Set(ids).size === ids.length, 'A card is a member of a group once.');
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
      // Exactly one: a card, or a group whose members feed in member order.
      fromPlacementId: id.optional(),
      fromGroupId: id.optional(),
      toPlacementId: id,
      slot: slotName,
    })
    .strict(),
  z.object({ type: z.literal('feed.remove'), id, braneId: id }).strict(),
  z
    .object({
      type: z.literal('relation.create'),
      id,
      braneId: id,
      fromPlacementId: id,
      toPlacementId: id,
      label: relationLabel,
    })
    .strict(),
  z.object({ type: z.literal('relation.relabel'), id, braneId: id, label: relationLabel }).strict(),
  z.object({ type: z.literal('relation.remove'), id, braneId: id }).strict(),
  z
    .object({
      type: z.literal('group.create'),
      id,
      braneId: id,
      label: groupLabel,
      display: groupDisplay,
      members,
    })
    .strict(),
  // An edit states the whole group: its label, display and members in order.
  z
    .object({
      type: z.literal('group.edit'),
      id,
      braneId: id,
      label: groupLabel,
      display: groupDisplay,
      members,
    })
    .strict(),
  z.object({ type: z.literal('group.remove'), id, braneId: id }).strict(),
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
    case 'relation.create':
    case 'relation.relabel':
    case 'relation.remove':
      return `relation:${command.id}`;
    case 'group.create':
    case 'group.edit':
    case 'group.remove':
      return `group:${command.id}`;
    case 'brane.create':
    case 'brane.title':
      return `brane:${command.id}`;
    default:
      return `placement:${command.id}`;
  }
}
