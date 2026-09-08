import { beforeEach, afterEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import { createImports } from '../server/services/imports';
import { createBrane, createBlock, readRevision, revisions, uid } from '../server/services/content';
import { encodeContent } from '../server/services/representations';
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
  (await createImports(db, store).import(
    actor,
    {
      key: uid(),
      braneId: brane,
      target: 'canvas',
      geometry: { x: 0, y: 0, width: 320, height: 300 },
    },
    new File([pdfFixture(['Original evidence'])], 'Report.pdf'),
  )) as any;
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
