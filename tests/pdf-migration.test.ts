import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openDatabase } from '../server/db/index';
import {
  createBrane,
  createBlock,
  createTextBlock,
  revisions,
  uid,
} from '../server/services/content';
import { readInputs } from '../server/services/contexts';
it('rebuilds block formats with existing placements, revisions and runs intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-migration-'));
  const path = join(directory, 'db.sqlite');
  let db = new Database(path);
  try {
    db.pragma('foreign_keys = OFF');
    db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY)');
    for (const name of readdirSync('migrations')
      .filter((name) => name.endsWith('.sql') && name < '011-')
      .sort()) {
      db.exec(readFileSync(join('migrations', name), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name);
    }
    db.pragma('foreign_keys = ON');
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
    const revision = revisions(db).snapshotBlock(actor, block.id);
    const output = createBlock(
      db,
      actor,
      'text',
      { format: 'text', text: '' },
      brane,
      undefined,
      'generated',
    );
    const conversation = uid(),
      runId = uid();
    db.prepare('INSERT INTO conversations VALUES (?,?,?)').run(conversation, actor, 0);
    db.prepare(
      "INSERT INTO runs (id,owner_id,brane_id,submission_key,request_hash,status,provider,model,options_json,output_block_id,conversation_id,created_at) VALUES (?,?,?,?,?,'queued','mock','mock','{}',?,?,0)",
    ).run(runId, actor, brane, uid(), 'fixture', output.id, conversation);
    db.prepare("INSERT INTO run_inputs VALUES (?,0,'prompt','Prompt','user',?)").run(
      runId,
      revision.id,
    );
    const inputs = [
      {
        position: 0,
        kind: 'prompt',
        label: 'Prompt',
        role: 'user',
        revision_id: revision.id,
        content: revision.content,
      },
    ];
    db.close();
    db = openDatabase(path);
    expect(readInputs(db, runId)).toEqual(inputs);
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
