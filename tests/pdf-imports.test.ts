import { beforeEach, afterEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db/index';
import { createImports } from '../server/services/imports';
import { createBrane, revisions, uid } from '../server/services/content';
import { resolveMessages } from '../server/llm/assets';
import { freePrice, estimatedInputTokens } from '../server/services/costs';
import { submitRun, readInputs } from '../server/services/runs';
import { modelCompatibility, representationText } from '../shared/representations';
import { pdfFixture } from './fixtures/pdf';
import type { PdfContent } from '../shared/types/domain';
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
  actor = uid();
  objects.clear();
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
const intent = () => ({
  key: uid(),
  braneId: brane,
  target: 'composer',
  geometry: { x: 20, y: 40, width: 320, height: 300 },
});
const upload = (pages: string[]) =>
  createImports(db, store).import(
    actor,
    intent(),
    new File([pdfFixture(pages)], 'Research.pdf', { type: 'application/pdf' }),
  ) as Promise<{ id: string; content: PdfContent }>;
it('retains original PDF bytes and freezes page-aware text with an explicit extractor version', async () => {
  const original = pdfFixture(['First page evidence', '', 'Third page conclusion']);
  const result = await upload(['First page evidence', '', 'Third page conclusion']);
  expect(Buffer.from(objects.get(result.content.assetId)!)).toEqual(original);
  expect(result.content).toMatchObject({
    format: 'pdf',
    pageCount: 3,
    mimeType: 'application/pdf',
    representation: {
      kind: 'pdf-text-v1',
      status: 'ready',
      pages: [
        { number: 1, text: 'First page evidence' },
        { number: 2, text: '' },
        { number: 3, text: 'Third page conclusion' },
      ],
    },
  });
  expect(result.content.representation.extractor).toMatch(/^pdfjs-/);
  expect(modelCompatibility(result.content, false)).toBeUndefined();
  const run = submitRun(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key: uid(),
      model: 'text-only',
      prompt: 'Summarize',
      references: [result.id],
      edits: [],
    },
    {
      models: ['text-only'],
      maxTokens: 100,
      userConcurrency: 3,
      maxContextCharacters: 100000,
      costPolicy: { dailyLimitUsd: 1, prices: { 'text-only': freePrice } },
    },
  );
  // A later representation change cannot alter the submitted pages.
  const edited = {
    ...result.content,
    representation: {
      ...result.content.representation,
      pages: [{ number: 1, text: 'Later extraction' }],
    },
  };
  db.prepare('UPDATE block_live_state SET content_json=?,version=version+1 WHERE block_id=?').run(
    JSON.stringify(edited),
    result.id,
  );
  const inputs = readInputs(db, run.id);
  const messages = await resolveMessages(db, store, actor, inputs);
  expect(messages[0].content).toContain('[Page 3]\nThird page conclusion');
  expect(messages[0].content).toContain('[No extractable text on this page]');
  expect(messages[0].content).not.toContain('Later extraction');
  expect(typeof messages[0].content).toBe('string');
  // PDF text has no image-token surcharge, even with a vision model.
  expect(estimatedInputTokens(inputs, { ...freePrice, imageTokenBound: 9999 })).toBe(
    estimatedInputTokens(inputs, freePrice),
  );
  objects.set(result.content.assetId, Buffer.from('changed'));
  await expect(resolveMessages(db, store, actor, inputs)).rejects.toThrow('no longer matches');
});
it('stores graphical PDFs but explicitly blocks model submission when there is no embedded text', async () => {
  const result = await upload(['']);
  expect(objects.has(result.content.assetId)).toBe(true);
  expect(result.content.representation).toMatchObject({ status: 'unavailable' });
  expect(modelCompatibility(result.content, true)).toContain('OCR');
  expect(revisions(db).snapshotBlock(actor, result.id).content).toEqual(result.content);
  expect(() =>
    submitRun(
      db,
      revisions(db),
      actor,
      {
        braneId: brane,
        key: uid(),
        model: 'mock',
        prompt: 'Read',
        references: [result.id],
        edits: [],
      },
      { models: ['mock'], maxTokens: 100, userConcurrency: 3, maxContextCharacters: 100000 },
    ),
  ).toThrow('OCR');
  expect((db.prepare('SELECT count(*) n FROM runs').get() as any).n).toBe(0);
});
it('retains an oversized document without silently submitting partial extraction', async () => {
  const result = await upload(Array.from({ length: 101 }, () => 'Page'));
  expect(result.content.pageCount).toBe(101);
  expect(result.content.representation).toMatchObject({ status: 'unavailable' });
  expect(representationText(result.content)).toBe('Research.pdf');
  expect(objects.size).toBe(1);
});
it('rejects malformed PDF data before publishing a file or artifact', async () => {
  await expect(
    createImports(db, store).import(
      actor,
      intent(),
      new File(['%PDF-1.7\nbroken'], 'broken.pdf', { type: 'application/pdf' }),
    ),
  ).rejects.toThrow('could not be parsed');
  expect(objects.size).toBe(0);
  expect((db.prepare('SELECT count(*) n FROM blocks').get() as any).n).toBe(0);
});

it('retains the complete original when extracted text exceeds its bounded representation', async () => {
  const pages = Array.from({ length: 10 }, () =>
    Array.from({ length: 40 }, () => 'Evidence '.repeat(8)).join('\n'),
  );
  const result = await upload(pages);
  expect(result.content.representation).toMatchObject({ status: 'unavailable' });
  expect(Buffer.from(objects.get(result.content.assetId)!)).toEqual(pdfFixture(pages));
});

it('starts and tears down independent parser workers under concurrent load', async () => {
  const { inspectPdf } = await import('../server/ingestion/pdf');
  for (let round = 0; round < 3; round++) {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => inspectPdf(pdfFixture(['']))),
    );
    expect(results.every((result) => result.representation.status === 'unavailable')).toBe(true);
  }
});
