import { beforeEach, afterEach, expect, it } from 'vitest';
import sharp from 'sharp';
import { openDatabase, type DB } from '../server/db/index';
import { createImports } from '../server/services/imports';
import {
  createBrane,
  createBlock,
  revisions,
  uid,
  readBrane,
  updatePlacementGeometry,
  removePlacement,
} from '../server/services/content';
import { reserveUpload } from '../server/services/capacity';
import { resolveMessages } from '../server/llm/assets';
import type { AssetStore } from '../server/storage/assets';
let db: DB, actor: string, brane: string, bytes: Buffer;
const objects = new Map<string, Uint8Array>();
const store: AssetStore = {
  put: async (key, bytes) => {
    if (objects.has(key)) throw Object.assign(new Error('immutable'), { code: 'EEXIST' });
    objects.set(key, bytes);
  },
  get: async (key) => {
    const bytes = objects.get(key);
    if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return bytes;
  },
  delete: async (key) => {
    objects.delete(key);
  },
  createReadUrl: async () => '',
};
beforeEach(async () => {
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
  bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
});
afterEach(() => db.close());
const intent = () => ({
  key: uid(),
  braneId: brane,
  target: 'composer',
  geometry: { x: 420, y: 70, width: 320, height: 300 },
});
const contentOf = (receipt: any, owner = actor) =>
  readBrane(db, owner, receipt.braneId).blocks.find((b) => b.id === receipt.blockId)!
    .content as any;
const file = () => new File([new Uint8Array(bytes)], 'Screenshot.png', { type: 'image/png' });
it('deduplicates concurrent and lost-response delivery, including after service restart', async () => {
  const imports = createImports(db, store),
    request = intent();
  const [first, second] = (await Promise.all([
    imports.import(actor, request, file()),
    imports.import(actor, request, file()),
  ])) as any[];
  expect(second).toEqual(first);
  expect(readBrane(db, actor, brane).placements[0]).toMatchObject(request.geometry);
  expect(contentOf(first)).toMatchObject({
    format: 'image',
    width: 12,
    height: 8,
    frames: 1,
    filename: 'Screenshot.png',
  });
  expect(await createImports(db, store).import(actor, request, file())).toEqual(first);
  expect(imports.status(actor, request.key)).toEqual({ state: 'ready', result: first });
  expect(objects.size).toBe(1);
  expect((db.prepare('SELECT count(*) n FROM blocks').get() as any).n).toBe(1);
  await expect(
    imports.import(actor, { ...request, geometry: { ...request.geometry, x: 0 } }, file()),
  ).rejects.toThrow('different');
  await expect(
    imports.import(actor, request, new File([new Uint8Array(bytes)], 'Other.png')),
  ).rejects.toThrow('different');
  expect(() => imports.status(uid(), request.key)).toThrow('not found');
});
it('resumes bytes whose write acknowledgement was lost without another object or reservation', async () => {
  const request = intent();
  const failed = createImports(db, {
    ...store,
    put: async (key, bytes, mime) => {
      await store.put(key, bytes, mime);
      throw new Error('Lost acknowledgement');
    },
  });
  await expect(failed.import(actor, request, file())).rejects.toThrow('Lost acknowledgement');
  expect(failed.status(actor, request.key)).toEqual({ state: 'pending' });
  expect((db.prepare('SELECT count(*) n FROM upload_intents').get() as any).n).toBe(1);
  const result: any = await createImports(db, store).import(actor, request, file());
  expect(objects.size).toBe(1);
  expect((db.prepare('SELECT count(*) n FROM upload_intents').get() as any).n).toBe(0);
  const frozen = revisions(db).snapshotBlock(actor, result.blockId);
  const messages = await resolveMessages(db, store, actor, [
    {
      position: 0,
      kind: 'reference',
      label: 'Screenshot',
      role: 'user',
      revision_id: frozen.id,
      content: frozen.content,
    },
  ]);
  expect(Buffer.from((messages[0].content as any[])[1].image)).toEqual(bytes);
  objects.set(contentOf(result).assetId, Buffer.from('corrupt'));
  await expect(
    resolveMessages(db, store, actor, [
      {
        position: 0,
        kind: 'source',
        label: 'Screenshot',
        role: 'user',
        revision_id: frozen.id,
        content: frozen.content,
      },
    ]),
  ).rejects.toThrow('no longer matches');
});
it('rolls back artifact publication and resumes after metadata failure', async () => {
  const imports = createImports(db, store),
    request = intent();
  db.exec(
    "CREATE TRIGGER fail_block BEFORE INSERT ON blocks BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  await expect(imports.import(actor, request, file())).rejects.toThrow('fixture');
  expect((db.prepare('SELECT count(*) n FROM assets').get() as any).n).toBe(0);
  db.exec('DROP TRIGGER fail_block');
  await imports.import(actor, request, file());
  expect(objects.size).toBe(1);
});
it('rejects malformed, empty, executable and over-pixel-limit images before storage', async () => {
  const imports = createImports(db, store);
  const huge = await sharp({
    create: { width: 5000, height: 5000, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  for (const bad of [
    Buffer.alloc(0),
    bytes.subarray(0, 40),
    Buffer.from('<svg onload="alert(1)"/>'),
    huge,
  ])
    await expect(
      imports.import(
        actor,
        intent(),
        new File([new Uint8Array(bad)], 'image.png', { type: 'image/png' }),
      ),
    ).rejects.toThrow();
  expect(objects.size).toBe(0);
  expect((db.prepare('SELECT count(*) n FROM artifact_imports').get() as any).n).toBe(0);
  expect(() => createBlock(db, actor, 'image', { format: 'text', text: 'bad' }, brane)).toThrow(
    'match',
  );
});

it('requires a still-image representation for animated model context', async () => {
  const { modelCompatibility } = await import('../shared/representations');
  const result: any = await createImports(db, store).import(actor, intent(), file());
  expect(modelCompatibility({ ...contentOf(result), frames: 2 })).toContain('still image');
});

it('shares immutable bytes across distinct artifacts only within an owner', async () => {
  const imports = createImports(db, store);
  const first: any = await imports.import(actor, intent(), file());
  const second: any = await imports.import(actor, intent(), file());
  expect(first.blockId).not.toBe(second.blockId);
  expect(first.placementId).not.toBe(second.placementId);
  expect(contentOf(first).assetId).toBe(contentOf(second).assetId);
  expect(objects.size).toBe(1);
  const asset = db.prepare('SELECT * FROM assets').get() as any;
  expect(asset.digest).toBe(contentOf(first).assetHash);
  expect(() =>
    db.prepare('UPDATE assets SET mime=? WHERE id=?').run('image/jpeg', asset.id),
  ).toThrow('immutable');
  const other = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    other,
    'B',
    `${other}@test`,
    0,
    0,
  );
  const third: any = await imports.import(
    other,
    { ...intent(), braneId: createBrane(db, other).id },
    file(),
  );
  expect(contentOf(third, other).assetId).not.toBe(contentOf(first).assetId);
  expect(objects.size).toBe(2);
});

it('shares an uncertain upload reservation across different import keys', async () => {
  const request = intent();
  await expect(
    createImports(db, {
      ...store,
      put: async (key, bytes, mime) => {
        await store.put(key, bytes, mime);
        throw new Error('uncertain');
      },
    }).import(actor, request, file()),
  ).rejects.toThrow('uncertain');
  const second: any = await createImports(db, store).import(actor, intent(), file());
  const first: any = await createImports(db, store).import(actor, request, file());
  expect(first.blockId).not.toBe(second.blockId);
  expect(contentOf(first).assetId).toBe(contentOf(second).assetId);
  expect(objects.size).toBe(1);
  expect(db.prepare('SELECT count(*) n FROM upload_intents').get()).toEqual({ n: 0 });
});

it('counts canonical bytes once and keeps uncertain reservations in quota admission', async () => {
  await createImports(db, store).import(actor, intent(), file());
  await createImports(db, store).import(actor, intent(), file());
  const limits = { userBytes: bytes.length + 10, totalBytes: bytes.length + 10 };
  reserveUpload(db, actor, uid(), 6, limits);
  expect(() => reserveUpload(db, actor, uid(), 5, limits)).toThrow('capacity');
  expect(db.prepare('SELECT sum(size) n FROM assets').get()).toEqual({ n: bytes.length });
});
it('converges concurrent distinct deliveries across service instances', async () => {
  const [a, b] = (await Promise.all([
    createImports(db, store).import(actor, intent(), file()),
    createImports(db, store).import(actor, intent(), file()),
  ])) as any[];
  expect(a.blockId).not.toBe(b.blockId);
  expect(contentOf(a).assetId).toBe(contentOf(b).assetId);
  expect(objects.size).toBe(1);
});

it('returns only stable creation identities after movement or removal', async () => {
  const imports = createImports(db, store),
    request = intent();
  const first = await imports.import(actor, request, file());
  expect(Object.keys(first).sort()).toEqual(['blockId', 'braneId', 'placementId']);
  updatePlacementGeometry(db, actor, first.placementId, {
    ...request.geometry,
    x: 999,
    version: 0,
  });
  expect(await createImports(db, store).import(actor, request, file())).toEqual(first);
  expect(readBrane(db, actor, brane).placements[0].x).toBe(999);
  removePlacement(db, actor, first.placementId);
  expect(imports.status(actor, request.key)).toEqual({ state: 'ready', result: first });
  expect(await imports.import(actor, request, file())).toEqual(first);
  expect(readBrane(db, actor, brane).placements).toEqual([]);
  expect(() => db.prepare("UPDATE artifact_imports SET placement_id='other'").run()).toThrow(
    'immutable',
  );
});
it('converges concurrent same-key deliveries across service instances', async () => {
  const request = intent();
  const results = await Promise.all([
    createImports(db, store).import(actor, request, file()),
    createImports(db, store).import(actor, request, file()),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(db.prepare('SELECT count(*) n FROM blocks').get()).toEqual({ n: 1 });
});
