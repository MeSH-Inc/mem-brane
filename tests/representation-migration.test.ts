import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { it, expect } from 'vitest';
import { openDatabase } from '../server/db';
import { createBrane, readRevision, readBrane, uid } from '../server/services/content';
import { decodeContent, encodeContent } from '../server/services/representations';
import { buildMessages } from '../server/llm/model';
import { pdfFixture } from './fixtures/pdf';
import { inspectPdf } from '../server/ingestion/pdf';
import type { Content, RunInput } from '../shared/types/domain';
it('migrates repeated PDF extractions without changing expanded content or messages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-representation-migration-'));
  const path = join(directory, 'db.sqlite');
  let db = new Database(path);
  try {
    db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY)');
    for (const name of readdirSync('migrations')
      .filter((n) => n.endsWith('.sql') && n < '015-')
      .sort()) {
      db.exec(readFileSync(join('migrations', name), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name);
    }
    const actor = uid(),
      asset = uid(),
      brane = uid();
    db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
      actor,
      'A',
      `${actor}@test`,
      0,
      0,
    );
    db.prepare('INSERT INTO branes VALUES (?,?,?,?,?)').run(brane, actor, 'B', 0, 0);
    const bytes = pdfFixture(['Frozen PDF evidence']);
    db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?)').run(
      asset,
      actor,
      asset,
      'application/pdf',
      bytes.length,
      0,
    );
    const content: Content = {
      format: 'pdf',
      text: 'Paper',
      filename: 'Paper.pdf',
      assetId: asset,
      assetHash: createHash('sha256').update(bytes).digest('hex'),
      mimeType: 'application/pdf',
      ...(await inspectPdf(bytes)),
    };
    const ids = [uid(), uid()];
    for (const id of ids) {
      db.prepare("INSERT INTO blocks VALUES (?,?,'pdf',0,'authored')").run(id, actor);
      db.prepare('INSERT INTO block_live_state VALUES (?,?,0,0)').run(id, JSON.stringify(content));
      db.prepare(
        'INSERT INTO block_revisions (id,block_id,content_json,created_at,source_version) VALUES (?,?,?,0,0)',
      ).run(id, id, JSON.stringify(content));
    }
    const input = (content: Content): RunInput[] => [
      {
        position: 0,
        kind: 'reference',
        label: 'Paper',
        role: 'user',
        revision_id: ids[0],
        content,
      },
    ];
    const before = buildMessages(input(content));
    db.close();
    db = openDatabase(path);
    expect(db.prepare('SELECT count(*) n FROM asset_representations').get()).toEqual({ n: 1 });
    for (const id of ids) expect(readRevision(db, actor, id).content).toEqual(content);
    expect(buildMessages(input(readRevision(db, actor, ids[0]).content))).toEqual(before);
    const encoded = encodeContent(db, actor, content);
    expect(decodeContent(db, encoded)).toEqual(content);
    expect(db.prepare('SELECT count(*) n FROM asset_representations').get()).toEqual({ n: 1 });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
