import { createHash } from 'node:crypto';
import { canonicalJson } from '../domain/canonical.js';
import { canEditBrane, DomainError } from '../domain/access.js';
import type { DB } from '../db/index.js';
import { workspaceOperation, type WorkspaceOperation } from '../../shared/workspace-commands.js';
import {
  createBrane,
  createBlock,
  createPlacement,
  updateBlockLiveState,
  updatePlacementGeometry,
  getPlacement,
  removePlacement,
  now,
} from './content.js';

export function applyWorkspaceOperation(db: DB, actor: string, input: WorkspaceOperation) {
  const operation = workspaceOperation.parse(input);
  const hash = createHash('sha256').update(canonicalJson(operation.command)).digest('hex');
  return db
    .transaction(() => {
      const receipt = db
        .prepare(
          'SELECT request_hash FROM workspace_operations WHERE owner_id=? AND operation_key=?',
        )
        .get(actor, operation.key) as { request_hash: string } | undefined;
      if (receipt) {
        if (receipt.request_hash !== hash)
          throw new DomainError(409, 'Operation key was already used with different content.');
        return { key: operation.key };
      }
      const command = operation.command;
      switch (command.type) {
        case 'brane.create':
          assertUnused(db, 'branes', command.id);
          createBrane(db, actor, command.title, command.id);
          break;
        case 'brane.title': {
          const brane = canEditBrane(db, actor, command.id);
          if (brane.title !== command.previous)
            throw new DomainError(409, 'This brane title changed elsewhere.');
          db.prepare('UPDATE branes SET title=?,updated_at=? WHERE id=?').run(
            command.title,
            now(),
            command.id,
          );
          break;
        }
        case 'text.create':
          assertUnused(db, 'blocks', command.blockId);
          assertUnused(db, 'placements', command.placementId);
          createBlock(
            db,
            actor,
            'text',
            { format: 'text', text: '' },
            command.braneId,
            command.geometry,
            'authored',
            command,
          );
          break;
        case 'text.edit':
          updateBlockLiveState(db, actor, command);
          break;
        case 'placement.create':
          assertUnused(db, 'placements', command.id);
          createPlacement(
            db,
            actor,
            command.braneId,
            command.blockId,
            command.geometry,
            command.id,
          );
          break;
        case 'placement.edit':
          updatePlacementGeometry(db, actor, command.id, command);
          break;
        case 'placement.remove':
          if (getPlacement(db, actor, command.id).brane_id !== command.braneId)
            throw new DomainError(400, 'Placement does not belong to this brane.');
          if (getPlacement(db, actor, command.id).version !== command.version)
            throw new DomainError(409, 'This placement changed before removal.');
          removePlacement(db, actor, command.id);
          break;
      }
      db.prepare('INSERT INTO workspace_operations VALUES (?,?,?,?)').run(
        actor,
        operation.key,
        hash,
        now(),
      );
      return { key: operation.key };
    })
    .immediate();
}
function assertUnused(db: DB, table: 'branes' | 'blocks' | 'placements', id: string) {
  if (db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id))
    throw new DomainError(409, 'This identity is already in use.');
}
