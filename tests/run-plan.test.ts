import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import {
  createBrane,
  createTextBlock,
  createBlock,
  revisions,
  uid,
  updateBlockLiveState,
} from '../server/services/content';
import { submitRun, type RunLimits } from '../server/services/runs';
import { estimateRun } from '../server/services/estimate';
import { readInputs } from '../server/services/contexts';
import { claimRun, startAttempt, completeAttempt } from '../server/services/run-lifecycle';
import { readRunCost } from '../server/db/records';
import { quoteCost } from '../server/services/costs';
import type { SubmitRun } from '../shared/types/domain';
let db: DB, actor: string, braneId: string;
const limits: RunLimits = {
  models: ['paid'],
  maxTokens: 100,
  userConcurrency: 20,
  queueLimit: 20,
  maxContextCharacters: 100000,
  costPolicy: {
    dailyLimitUsd: 10,
    prices: {
      paid: {
        inputUsdPerMillion: 0.07,
        outputUsdPerMillion: 2,
        vision: true,
        imageTokenBound: 500,
        source: 'https://example.com/pricing',
        verifiedAt: '2026-09-08',
      },
    },
  },
};
beforeEach(() => {
  db = openDatabase(':memory:');
  actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Planner',
    `${actor}@test`,
    0,
    0,
  );
  braneId = createBrane(db, actor).id;
});
afterEach(() => db.close());
function request(extra: Partial<SubmitRun> = {}): SubmitRun {
  return {
    braneId,
    key: uid(),
    model: 'paid',
    prompt: 'Explore',
    references: [],
    edits: [],
    ...extra,
  };
}
function state() {
  return [
    'blocks',
    'block_live_state',
    'block_revisions',
    'context_manifests',
    'context_entries',
    'conversations',
    'runs',
    'run_costs',
    'submission_receipts',
  ].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
}
function parity(input: SubmitRun, options = limits) {
  const before = state();
  const preview = estimateRun(db, actor, input, options);
  expect(state()).toEqual(before);
  const run = submitRun(db, revisions(db), actor, input, options);
  const stored = readRunCost(db, run.id);
  expect(stored.estimated_input_tokens).toBe(preview.estimatedInputTokens);
  expect(stored.reserved_microusd).toBe(preview.reservedMicrousd);
  expect(stored.price).toEqual(preview.price);
  const outputLimit = JSON.parse(run.options_json).maxOutputTokens;
  const actual = quoteCost(input.model, readInputs(db, run.id), outputLimit, options.costPolicy);
  expect(actual.inputTokens).toBe(preview.estimatedInputTokens);
  expect(actual.amount).toBe(preview.reservedMicrousd);
  return run;
}
it.each([undefined, 12, 1000])(
  'matches unsaved Unicode edits and output limit %s',
  (maxOutputTokens) => {
    const block = createTextBlock(db, actor, braneId).id;
    const run = parity(
      request({
        references: [block],
        edits: [{ blockId: block, version: 0, text: 'New draft 🧠 漢字 "quoted"\nline' }],
        maxOutputTokens,
      }),
    );
    expect(JSON.parse(run.options_json).maxOutputTokens).toBe(
      Math.min(maxOutputTokens ?? 100, 100),
    );
    expect(readInputs(db, run.id)[0].content.text).toContain('New draft');
  },
);
it('uses webpage edit normalization in both paths', () => {
  const block = createBlock(
    db,
    actor,
    'webpage',
    {
      format: 'webpage',
      url: 'https://example.com',
      text: '',
      status: 'failed',
      error: 'Import failed',
    },
    braneId,
  ).id;
  const run = parity(
    request({
      references: [block],
      edits: [{ blockId: block, version: 0, text: 'Manually recovered page' }],
    }),
  );
  expect(readInputs(db, run.id)[0].content).toMatchObject({
    text: 'Manually recovered page',
    status: 'ready',
  });
  expect(readInputs(db, run.id)[0].content).not.toHaveProperty('error');
});
it('prices image context including the frozen image token bound', () => {
  const asset = uid();
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run(
    asset,
    actor,
    asset,
    'image/png',
    1,
    0,
    'a'.repeat(64),
  );
  const block = createBlock(
    db,
    actor,
    'image',
    {
      format: 'image',
      filename: 'image',
      representation: 'original-image-v1',
      text: 'image',
      assetId: asset,
      assetHash: 'a'.repeat(64),
      mimeType: 'image/png',
    },
    braneId,
  ).id;
  parity(request({ references: [block] }));
  const unsupported = {
    ...limits,
    costPolicy: {
      ...limits.costPolicy!,
      prices: { paid: { ...limits.costPolicy!.prices.paid, vision: false } },
    },
  };
  expect(() => estimateRun(db, actor, request({ references: [block] }), unsupported)).toThrow(
    'does not support image',
  );
  expect(() =>
    submitRun(db, revisions(db), actor, request({ references: [block] }), unsupported),
  ).toThrow('does not support image');
});
it('expands frozen conversation references alongside current drafts', () => {
  const block = createTextBlock(db, actor, braneId).id;
  updateBlockLiveState(db, actor, { blockId: block, version: 0, text: 'Original reference' });
  const first = submitRun(db, revisions(db), actor, request({ references: [block] }), limits);
  claimRun(db, 'worker', 1000);
  const attempt = startAttempt(db, first.id, 'worker')!;
  expect(
    completeAttempt(db, attempt, {
      text: 'Prior answer',
      usage: { inputTokens: 10, outputTokens: 10 },
    }),
  ).toBe(true);
  const message = db
    .prepare<unknown[], { message_id: string }>('SELECT message_id FROM run_outputs WHERE run_id=?')
    .get(first.id)!;
  const next = parity(
    request({
      continueFrom: message.message_id,
      references: [block],
      edits: [{ blockId: block, version: 1, text: 'Current draft is different' }],
    }),
  );
  const inputs = readInputs(db, next.id);
  expect(inputs.map((i) => i.kind)).toEqual([
    'lineage_reference',
    'lineage',
    'lineage',
    'reference',
    'prompt',
  ]);
  expect(inputs[0].content.text).toBe('Original reference');
  expect(inputs[3].content.text).toBe('Current draft is different');
});
it.each(['stale', 'unfinished', 'oversized', 'duplicate'])(
  'rejects %s consistently without persistence',
  (kind) => {
    const block = createTextBlock(db, actor, braneId).id;
    let input = request({ references: [block] });
    let options = limits;
    if (kind === 'stale') input.edits = [{ blockId: block, version: 9, text: 'stale' }];
    if (kind === 'duplicate')
      input.edits = [
        { blockId: block, version: 0, text: 'one' },
        { blockId: block, version: 0, text: 'two' },
      ];
    if (kind === 'oversized') options = { ...limits, maxContextCharacters: 1 };
    if (kind === 'unfinished') {
      const run = submitRun(db, revisions(db), actor, request(), limits);
      input = request({ references: [run.output_block_id] });
    }
    const before = state();
    let message = '';
    try {
      estimateRun(db, actor, input, options);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(() => submitRun(db, revisions(db), actor, input, options)).toThrow(message);
    expect(state()).toEqual(before);
  },
);
it('does not turn a preview into a stale reservation', () => {
  const block = createTextBlock(db, actor, braneId).id;
  const input = request({ references: [block] });
  const preview = estimateRun(db, actor, input, limits);
  updateBlockLiveState(db, actor, {
    blockId: block,
    version: 0,
    text: 'A much longer reference '.repeat(100),
  });
  const run = submitRun(db, revisions(db), actor, input, limits);
  expect(readRunCost(db, run.id).estimated_input_tokens).toBeGreaterThan(
    preview.estimatedInputTokens,
  );
});
it('reports an exhausted operator budget even for zero-priced paid models', () => {
  const options = {
    ...limits,
    costPolicy: {
      ...limits.costPolicy!,
      globalDailyLimitUsd: 0,
      prices: {
        paid: { ...limits.costPolicy!.prices.paid, inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      },
    },
  };
  const input = request();
  expect(estimateRun(db, actor, input, options).canAfford).toBe(false);
  expect(() => submitRun(db, revisions(db), actor, input, options)).toThrow('budget');
});
