import { beforeEach, afterEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import { createImports } from '../server/services/imports';
import {
  readBrane,
  createBrane,
  createBlock,
  readRevision,
  revisions,
  uid,
} from '../server/services/content';
import { encodeContent, decodeContent } from '../server/services/representations';
import { verifyRestoration } from '../server/storage/verify';
import { pdfFixture } from './fixtures/pdf';
import type { AssetStore } from '../server/storage/assets';
let db: DB, actor: string, brane: string;
const objects = new Map<string, Uint8Array>();
const store: AssetStore = {
  put: async (key, bytes) => {
    objects.set(key, bytes);
  },
  get: async (key) => objects.get(key)!,
  delete: async (key) => {
    objects.delete(key);
  },
  createReadUrl: async () => '',
};
beforeEach(() => {
  db = openDatabase(':memory:');
  objects.clear();
  actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'A',
    `${actor}@test`,
    0,
    0,
  );
  brane = createBrane(db, actor).id;
});
afterEach(() => db.close());
const upload = async () =>
  (await createImports(db, store)
    .import(
      actor,
      {
        key: uid(),
        braneId: brane,
        target: 'canvas',
        geometry: { x: 0, y: 0, width: 320, height: 300 },
      },
      new File([pdfFixture(['Original evidence'])], 'Report.pdf'),
    )
    .then((receipt) => ({
      id: receipt.blockId,
      content: decodeContent(
        db,
        (
          db
            .prepare('SELECT content_json FROM block_live_state WHERE block_id=?')
            .get(receipt.blockId) as { content_json: string }
        ).content_json,
      ),
    }))) as any;
it('stores one extraction for repeated artifacts and snapshots with real foreign keys', async () => {
  const a = await upload(),
    b = await upload();
  for (const block of [a, b]) revisions(db).snapshotBlock(actor, block.id);
  expect(db.prepare('SELECT count(*) n FROM asset_representations').get()).toEqual({ n: 1 });
  const rows = db
    .prepare(
      'SELECT content_json,representation_id FROM block_live_state UNION ALL SELECT content_json,representation_id FROM block_revisions',
    )
    .all() as any[];
  expect(rows).toHaveLength(4);
  for (const row of rows) {
    expect(JSON.parse(row.content_json)).toEqual({
      format: 'pdf',
      text: 'Report.pdf',
      filename: 'Report.pdf',
      representationId: row.representation_id,
    });
  }
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(await verifyRestoration(db, store)).toMatchObject({ assets: 1, references: 4 });
});
it('pins older extraction identities and rejects mutation, missing references and foreign owners', async () => {
  const a = await upload(),
    frozen = revisions(db).snapshotBlock(actor, a.id);
  const next = {
    ...a.content,
    representation: {
      kind: 'pdf-text-v1',
      extractor: 'next-extractor',
      status: 'ready',
      pages: [{ number: 1, text: 'New evidence' }],
    },
  } as const;
  const encoded = encodeContent(db, actor, next as any);
  db.prepare('UPDATE block_live_state SET content_json=?,version=version+1 WHERE block_id=?').run(
    encoded,
    a.id,
  );
  const latest = revisions(db).snapshotBlock(actor, a.id);
  expect(readRevision(db, actor, frozen.id).content).toEqual(a.content);
  expect(latest.content).toEqual(next);
  expect(db.prepare('SELECT count(*) n FROM asset_representations').get()).toEqual({ n: 2 });
  expect(() => db.exec("UPDATE asset_representations SET payload_json='{}'")).toThrow('immutable');
  expect(() => db.exec('DELETE FROM asset_representations')).toThrow('immutable');
  expect(() =>
    db
      .prepare('UPDATE block_live_state SET content_json=? WHERE block_id=?')
      .run(JSON.stringify({ ...JSON.parse(encoded), representationId: 'missing' }), a.id),
  ).toThrow();
  const other = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    other,
    'B',
    `${other}@test`,
    0,
    0,
  );
  expect(() => createBlock(db, other, 'pdf', a.content)).toThrow('not found');
  const foreign = createBlock(db, other, 'text', { format: 'text', text: '' });
  expect(() =>
    db
      .prepare('UPDATE block_live_state SET content_json=? WHERE block_id=?')
      .run(encoded, foreign.id),
  ).toThrow('representation');
});
it.each(['missing', 'changed'])('detects %s representations during restoration', async (kind) => {
  await upload();
  db.pragma('foreign_keys=OFF');
  if (kind === 'missing')
    db.exec('DROP TRIGGER immutable_representation_delete; DELETE FROM asset_representations');
  else
    db.exec(
      `DROP TRIGGER immutable_representation_update; UPDATE asset_representations SET payload_json=json_set(payload_json,'$.representation.pages[0].text','Corruption')`,
    );
  await expect(verifyRestoration(db, store)).rejects.toThrow(/integrity/i);
});

it('keeps large PDF pages off workspace reads and authorizes exact representation reads', async () => {
  const { readPdfPages } = await import('../server/services/representations');
  const lines = Array.from({ length: 30 }, () => 'Detailed evidence '.repeat(4)).join('\n');
  const receipt = await createImports(db, store).import(
    actor,
    {
      key: uid(),
      braneId: brane,
      target: 'canvas',
      geometry: { x: 0, y: 0, width: 320, height: 300 },
    },
    new File([pdfFixture(Array.from({ length: 4 }, () => lines))], 'Long.pdf'),
  );
  const frozen = revisions(db).snapshotBlock(actor, receipt.blockId);
  expect(JSON.stringify(frozen.content).length).toBeGreaterThan(6000);
  const workspace = readBrane(db, actor, brane);
  expect(JSON.stringify(workspace).length).toBeLessThan(2000);
  expect(JSON.stringify(workspace)).not.toContain('Detailed evidence');
  const summary = workspace.blocks[0].content;
  if (summary.format !== 'pdf') throw new Error('expected PDF');
  expect(summary.representation).not.toHaveProperty('pages');
  expect(readPdfPages(db, actor, summary.representationId)).toEqual(
    (frozen.content as any).representation,
  );
  expect(() => readPdfPages(db, uid(), summary.representationId)).toThrow('not found');
  expect(() => readPdfPages(db, actor, 'f'.repeat(64))).toThrow('not found');
});

it('batches hundreds of shared identities and context references without changing provider messages', async () => {
  const { contentReader } = await import('../server/services/representations');
  const { lineageInputs } = await import('../server/services/contexts');
  const { buildMessages } = await import('../server/llm/model');
  const a = await upload();
  const refs = [];
  brane = createBrane(db, actor).id;
  for (let i = 0; i < 200; i++) {
    const block = createBlock(db, actor, 'pdf', { ...a.content, text: `Caption ${i}` }, brane);
    refs.push(revisions(db).snapshotBlock(actor, block.id));
  }
  const { vi } = await import('vitest');
  const prepare = db.prepare.bind(db),
    queries: string[] = [];
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    queries.push(sql);
    return prepare(sql);
  }) as typeof db.prepare);
  try {
    const state = readBrane(db, actor, brane);
    expect(state.blocks).toHaveLength(200);
    expect(queries.filter((sql) => sql.includes('FROM asset_representations'))).toHaveLength(1);
    queries.length = 0;
    const messages: any[] = [
      {
        id: uid(),
        role: 'user',
        revision_id: uid(),
        content: { format: 'text', text: 'Prompt' },
        references: refs.map((r) => ({ label: 'Evidence', revision_id: r.id })),
      },
    ];
    const expanded = lineageInputs(db, actor, messages);
    expect(queries.filter((sql) => sql.includes('FROM asset_representations'))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes('FROM block_revisions'))).toHaveLength(1);
    expect(buildMessages(expanded)).toEqual(
      buildMessages([
        ...refs.map((r, position) => ({
          position,
          kind: 'lineage_reference' as const,
          role: 'user' as const,
          label: 'Evidence',
          revision_id: r.id,
          content: r.content,
        })),
        {
          position: 200,
          kind: 'lineage' as const,
          role: 'user' as const,
          label: 'Conversation',
          revision_id: messages[0].revision_id,
          content: messages[0].content,
        },
      ]),
    );
    expect((expanded[0].content as any).representation).toBe(
      (expanded[199].content as any).representation,
    );
    const json = (
      db.prepare('SELECT content_json FROM block_live_state WHERE block_id=?').get(a.id) as {
        content_json: string;
      }
    ).content_json;
    expect(() => contentReader(db, uid(), 'full').prefetch([json])).toThrow('not found');
  } finally {
    spy.mockRestore();
  }
});
