import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import { authorizeLibrary, currentLibrary } from '../server/domain/libraries';
import { createBrane, createTextBlock, revisions, uid } from '../server/services/content';
import { submitRun } from '../server/services/runs';
import { committedSpend } from '../server/services/spend';
import { reserveUpload } from '../server/services/capacity';
let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => db.close());
function user() {
  const id = uid();
  db.prepare('INSERT INTO user (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    id,
    'Owner',
    `${id}@example.com`,
    0,
    0,
  );
  return id;
}
it('changes access without changing immutable run, revision, receipt or asset ownership', () => {
  const guest = user(),
    account = user(),
    library = currentLibrary(db, guest).id;
  const brane = createBrane(db, library);
  const block = createTextBlock(db, library, brane.id);
  const run = submitRun(
    db,
    revisions(db),
    library,
    {
      braneId: brane.id,
      key: uid(),
      model: 'mock',
      prompt: 'Frozen',
      references: [block.id],
      edits: [],
    },
    { models: ['mock'], maxTokens: 100, userConcurrency: 3, maxContextCharacters: 10000 },
  );
  const before = db.prepare('SELECT * FROM runs WHERE id=?').get(run.id);
  db.prepare('UPDATE libraries SET principal_id=? WHERE id=?').run(account, library);
  expect(() => authorizeLibrary(db, guest, library)).toThrow('cannot access');
  expect(authorizeLibrary(db, account, library).id).toBe(library);
  expect(db.prepare('SELECT * FROM runs WHERE id=?').get(run.id)).toEqual(before);
  expect(() => db.prepare('UPDATE runs SET owner_id=? WHERE id=?').run(account, run.id)).toThrow(
    'immutable',
  );
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('accounts for storage and spend across every library attached to an account', () => {
  const account = user(),
    library = uid();
  db.prepare('INSERT INTO libraries VALUES (?,?,?)').run(library, account, 1);
  reserveUpload(db, account, uid(), 60, { userBytes: 100, totalBytes: 1000 });
  expect(() => reserveUpload(db, library, uid(), 60, { userBytes: 100, totalBytes: 1000 })).toThrow(
    'capacity',
  );
  for (const owner of [account, library])
    db.prepare(
      `INSERT INTO spend_commitments
    VALUES (?,'ocr',NULL,?,'2026-09-18','reserved',10,1,NULL,'{}',0,0)`,
    ).run(uid(), owner);
  expect(committedSpend(db, '2026-09-18', { actor: library })).toBe(20);
});
