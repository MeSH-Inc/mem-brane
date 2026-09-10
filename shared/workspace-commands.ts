import { z } from 'zod';
import { id, geometry, edit, placementEdit } from './schemas/index.js';

const title = z.string().trim().min(1).max(200);
export const workspaceCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('brane.create'), id, title }).strict(),
  z.object({ type: z.literal('brane.title'), id, title, previous: z.string() }).strict(),
  z
    .object({ type: z.literal('text.create'), braneId: id, blockId: id, placementId: id, geometry })
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
]);
export const workspaceOperation = z.object({ key: id, command: workspaceCommand }).strict();
export const workspaceAcknowledgement = z.object({ key: id }).strict();
export type WorkspaceCommand = z.infer<typeof workspaceCommand>;
export type WorkspaceOperation = z.infer<typeof workspaceOperation>;
export function commandEntity(command: WorkspaceCommand): string {
  switch (command.type) {
    case 'text.create':
    case 'text.edit':
      return `block:${command.blockId}`;
    case 'brane.create':
    case 'brane.title':
      return `brane:${command.id}`;
    default:
      return `placement:${command.id}`;
  }
}
