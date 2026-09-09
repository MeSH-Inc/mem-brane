import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import { retryRun } from '../server/services/runs';
import { readInputs } from '../server/services/context-reader';
import { buildMessages } from '../server/llm/model';
import type { RunInput } from '../shared/types/domain';
import fixture from './fixtures/legacy-context.json';

function legacy(path: string): DB {
  const db = new Database(path);
  db.pragma('foreign_keys=OFF');
  db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY)');
  for (const name of readdirSync('migrations')
    .filter((name) => name.endsWith('.sql') && name < '014-')
    .sort()) {
    db.exec(readFileSync(join('migrations', name), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name);
  }
  for (const [table, rows] of Object.entries(fixture.tables))
    for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(
        `INSERT INTO "${table}" (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      ).run(...Object.values(row));
    }
  db.pragma('foreign_keys=ON');
  expect(db.pragma('foreign_key_check')).toEqual([]);
  return db;
}

it('migrates branches, user continuation, sources, images and retries without changing provider messages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-context-migration-'));
  const path = join(directory, 'db.sqlite');
  let db = legacy(path);
  try {
    const before = new Map<string, RunInput[]>();
    for (const run of fixture.tables.runs) {
      const rows = db
        .prepare(
          'SELECT i.position,i.kind,i.label,i.role,i.revision_id,v.content_json FROM run_inputs i JOIN block_revisions v ON v.id=i.revision_id WHERE run_id=? ORDER BY position',
        )
        .all(run.id) as (Omit<RunInput, 'content'> & { content_json: string })[];
      before.set(
        run.id,
        rows.map(({ content_json, ...row }) => ({ ...row, content: JSON.parse(content_json) })),
      );
    }
    const messages = new Map([...before].map(([id, inputs]) => [id, buildMessages(inputs)]));
    db.close();
    db = openDatabase(path);
    for (const [id, inputs] of before) {
      expect(readInputs(db, id)).toEqual(inputs);
      expect(buildMessages(readInputs(db, id))).toEqual(messages.get(id));
    }
    expect(db.prepare('SELECT * FROM run_outputs').all()).toEqual(fixture.tables.run_outputs);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='run_inputs'").get()).toBeUndefined();
    expect(
      (db.pragma('table_info(conversation_messages)') as { name: string }[]).some(
        (column) => column.name === 'context_json',
      ),
    ).toBe(false);
    const failed = fixture.tables.runs.find((run) => run.status === 'failed')!;
    const count = db.prepare('SELECT count(*) n FROM context_entries').get();
    const retried = retryRun(db, fixture.actor, failed.id, crypto.randomUUID(), {
      models: ['mock'],
      maxTokens: 100,
      userConcurrency: 3,
      maxContextCharacters: 100000,
    });
    expect(retried.context_id).toBe(failed.id);
    expect(readInputs(db, retried.id)).toEqual(before.get(failed.id));
    expect(db.prepare('SELECT count(*) n FROM context_entries').get()).toEqual(count);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(['lineage', 'references'])(
  'rejects and rolls back a migration with divergent %s truth',
  (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'membrane-context-invalid-'));
    const path = join(directory, 'db.sqlite');
    let db = legacy(path);
    if (kind === 'lineage') {
      db.exec('DROP TRIGGER immutable_input_update');
      db.prepare("UPDATE run_inputs SET label='Divergent' WHERE kind='lineage'").run();
    } else {
      db.exec('DROP TRIGGER immutable_message_update');
      db.prepare("UPDATE conversation_messages SET context_json='[]' WHERE role='user'").run();
    }
    db.close();
    try {
      expect(() => openDatabase(path)).toThrow('CHECK');
      db = new Database(path);
      expect(db.prepare('SELECT count(*) n FROM run_inputs').get()).toEqual({
        n: fixture.tables.run_inputs.length,
      });
      expect(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name='context_manifests'").get(),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT 1 FROM schema_migrations WHERE name='014-context-manifests.sql'").get(),
      ).toBeUndefined();
    } finally {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
