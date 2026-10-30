import type { DB } from '../db/index.js';
import { DomainError } from '../domain/access.js';
import { BUILT_IN_MACHINES } from '../../shared/machines.js';
import { now, uid } from './content.js';

export const MAX_WORKSHOP_MACHINES = 100;

export interface WorkshopMachine {
  id: string;
  name: string;
  template: string;
  created_at: number;
}

// The Workshop lists the built-in machines and the account's saved ones. An item is a
// prompt kept to be copied: taking it out places a new machine on a brane.
export function readWorkshop(db: DB, actor: string) {
  return {
    builtIn: BUILT_IN_MACHINES.map((m) => ({ name: m.name, template: m.template })),
    saved: db
      .prepare<unknown[], WorkshopMachine>(
        'SELECT id,name,template,created_at FROM workshop_machines WHERE owner_id=? ORDER BY created_at DESC,id',
      )
      .all(actor),
  };
}

export function saveWorkshopMachine(db: DB, actor: string, name: string, template: string) {
  if (
    (
      db.prepare('SELECT count(*) n FROM workshop_machines WHERE owner_id=?').get(actor) as {
        n: number;
      }
    ).n >= MAX_WORKSHOP_MACHINES
  )
    throw new DomainError(429, 'Workshop capacity reached', 'quota');
  const machine: WorkshopMachine = { id: uid(), name, template, created_at: now() };
  db.prepare('INSERT INTO workshop_machines VALUES (?,?,?,?,?)').run(
    machine.id,
    actor,
    machine.name,
    machine.template,
    machine.created_at,
  );
  return machine;
}

export function removeWorkshopMachine(db: DB, actor: string, id: string) {
  db.prepare('DELETE FROM workshop_machines WHERE id=? AND owner_id=?').run(id, actor);
}
