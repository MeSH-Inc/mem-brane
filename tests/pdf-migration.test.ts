import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openDatabase } from '../server/db/index';
import { createBrane, createTextBlock, revisions, uid } from '../server/services/content';
import { submitRun, readInputs } from '../server/services/runs';
it('rebuilds block formats with existing placements, revisions and runs intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-migration-'));
  const path = join(directory, 'db.sqlite');
  let db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY)');
    for (const name of readdirSync('migrations')
      .filter((name) => name.endsWith('.sql') && name < '011-')
      .sort()) {
      db.exec(readFileSync(join('migrations', name), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name);
    }
    const actor = uid();
    db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
      actor,
      'A',
      `${actor}@test`,
      0,
      0,
    );
    const brane = createBrane(db, actor).id;
    const block = createTextBlock(db, actor, brane);
    const run = submitRun(
      db,
      revisions(db),
      actor,
      {
        braneId: brane,
        key: uid(),
        model: 'mock',
        prompt: 'Frozen',
        references: [block.id],
        edits: [],
      },
      { models: ['mock'], maxTokens: 100, userConcurrency: 3, maxContextCharacters: 100000 },
    );
    const inputs = readInputs(db, run.id);
    db.close();
    db = openDatabase(path);
    expect(readInputs(db, run.id)).toEqual(inputs);
    expect(
      db.prepare('SELECT block_id FROM placements WHERE id=?').get(block.placement.id),
    ).toEqual({ block_id: block.id });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => db.prepare("UPDATE blocks SET kind='pdf' WHERE id=?").run(block.id)).toThrow(
      'Immutable',
    );
    expect(() =>
      db
        .prepare('UPDATE block_revisions SET content_json=? WHERE id=?')
        .run('{}', inputs[0].revision_id),
    ).toThrow('immutable');
    db.prepare("INSERT INTO blocks VALUES (?,?,'pdf',0,'authored')").run(uid(), actor);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
