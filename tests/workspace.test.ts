import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceController, type WorkspaceDependencies } from '../src/services/workspace';
import { useInteraction } from '../src/stores/interaction';
import { ApiError } from '../src/services/api';
import type { BraneState, Edit, SubmissionReceipt } from '../shared/types/domain';
import type { Draft } from '../src/services/drafts';
const controllers: WorkspaceController[] = [];
afterEach(async () => {
  controllers.splice(0).forEach((c) => c.dispose());
  vi.useRealTimers();
  await useInteraction.getState().flushRecovery();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function fixture() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const actor = crypto.randomUUID(),
    brane = crypto.randomUUID(),
    block = crypto.randomUUID();
  await useInteraction.getState().initialize(actor);
  const values = new Map<string, string>();
  const state: BraneState = {
    brane: { id: brane, title: 'Saved', created_at: 0, updated_at: 0 },
    blocks: [
      {
        id: block,
        kind: 'text',
        origin: 'authored',
        version: 0,
        content: { format: 'text', text: '' },
      },
    ],
    placements: [
      {
        id: crypto.randomUUID(),
        brane_id: brane,
        block_id: block,
        version: 0,
        x: 0,
        y: 0,
        width: 320,
        height: 220,
        z_index: 0,
      },
    ],
    runs: [],
    derivations: [],
  };
  const sent: { path: string; body: any }[] = [];
  let intercept: ((path: string, body?: any) => Promise<unknown> | undefined) | undefined;
  const request = vi.fn(async (path: string, body?: any) => {
    sent.push({ path, body: structuredClone(body) });
    const intercepted = intercept?.(path, body);
    if (intercepted) return intercepted;
    if (path === '/config')
      return {
        models: ['mock'],
        defaultModel: 'mock',
        budget: { availableMicrousd: 1, limitMicrousd: 1 },
        modelCapabilities: { mock: { vision: true } },
      };
    if (path === '/budget') return { availableMicrousd: 1, limitMicrousd: 1 };
    if (path === `/branes/${brane}`) {
      if (body) state.brane.title = body.title;
      return structuredClone(state);
    }
    if (path === '/blocks/live') {
      const current = state.blocks.find((b) => b.id === body.blockId)!;
      if (current.version !== body.version) throw new ApiError(409, 'changed');
      if (current.content.text !== body.text) current.version++;
      current.content = { format: 'text', text: body.text };
      return { version: current.version, content: current.content };
    }
    if (path === '/runs' || path === '/artifacts/spawn') return receipt(body.edits);
    if (path === '/runs/estimate') return { reservedMicrousd: 1, canAfford: true };
    if (path.startsWith('/context/lineage')) return [];
    throw new Error(`Unexpected request ${path}`);
  });
  const deps: WorkspaceDependencies = {
    request: request as WorkspaceDependencies['request'],
    drafts: useInteraction,
    events: new EventTarget(),
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
    imports: {
      subscribe: () => () => {},
      list: () => [],
      enqueue: async () => {},
      delivered: async () => {},
      maxBytes: 5000,
    },
  };
  function receipt(edits: Edit[], increment = 1): SubmissionReceipt {
    return {
      runId: crypto.randomUUID(),
      outputBlockId: crypto.randomUUID(),
      edits: edits.map((e) => ({
        blockId: e.blockId,
        version: e.version + increment,
        content: { format: 'text', text: e.text },
      })),
    };
  }
  const make = (id: string = brane) => {
    const c = new WorkspaceController(actor, id, deps);
    controllers.push(c);
    return c;
  };
  const c = make();
  c.start();
  await settle();
  return {
    c,
    actor,
    brane,
    block,
    state,
    deps,
    request,
    sent,
    make,
    receipt,
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
  };
}
it('keeps only the newest refresh and preserves acknowledged text and streaming during delayed reads', async () => {
  const f = await fixture();
  const first = deferred<BraneState>(),
    second = deferred<BraneState>();
  let count = 0;
  f.intercept((path) =>
    path === `/branes/${f.brane}` ? (++count === 1 ? first.promise : second.promise) : undefined,
  );
  const a = f.c.refresh(),
    b = f.c.refresh();
  const newest = structuredClone(f.state);
  newest.blocks[0].version = 2;
  newest.blocks[0].content.text = 'Newest';
  second.resolve(newest);
  await b;
  first.resolve(f.state);
  await a;
  expect(f.c.state!.blocks[0].content.text).toBe('Newest');
  const delayed = deferred<BraneState>();
  f.intercept((path) => (path === `/branes/${f.brane}` ? delayed.promise : undefined));
  const stale = f.c.refresh();
  f.c.edit(f.block, 'Acknowledged');
  // fixture server has received the newer version too
  f.state.blocks[0] = structuredClone(newest.blocks[0]);
  await f.c.saveBlock(f.block);
  delayed.resolve(newest);
  await stale;
  expect(f.c.state!.blocks[0]).toMatchObject({ version: 3, content: { text: 'Acknowledged' } });
});
it('retains SSE progress that arrives after a refresh begins', async () => {
  const f = await fixture();
  f.state.runs = [
    {
      id: 'run',
      brane_id: f.brane,
      status: 'running',
      model: 'mock',
      provider: 'mock',
      output_block_id: 'output',
      partial: 'Old',
      error: null,
      usage_json: null,
      retry_of: null,
      created_at: 0,
    },
  ];
  await f.c.refresh();
  const gate = deferred<BraneState>();
  f.intercept((path) => (path === `/branes/${f.brane}` ? gate.promise : undefined));
  const refresh = f.c.refresh();
  f.c.onRun({ braneId: f.brane, runId: 'run', text: 'New progress' });
  gate.resolve(structuredClone(f.state));
  await refresh;
  expect(f.c.state!.runs[0].partial).toBe('New progress');
});
it('disposal cancels timers and ignores delayed reads, while navigation preserves composer and recoverable text', async () => {
  const f = await fixture();
  f.c.updateDraft({ prompt: 'Unfinished', references: [f.block], title: 'Local title' });
  f.c.edit(f.block, 'Unsaved text');
  await useInteraction.getState().flushRecovery();
  const late = deferred<BraneState>();
  f.intercept((path) => (path === `/branes/${f.brane}` ? late.promise : undefined));
  const pending = f.c.refresh();
  const snapshot = f.c.getSnapshot();
  f.c.dispose();
  await vi.advanceTimersByTimeAsync(10000);
  late.resolve(f.state);
  await pending;
  expect(f.c.getSnapshot()).toBe(snapshot);
  expect(f.sent.filter((r) => r.path === '/blocks/live')).toEqual([]);
  expect(() => f.c.updateDraft({ prompt: 'Closed' })).toThrow('closed');
  f.intercept(undefined);
  const next = f.make();
  next.start();
  await settle();
  expect(next.draft).toMatchObject({
    prompt: 'Unfinished',
    references: [f.block],
    title: 'Local title',
  });
  await next.save();
  expect(f.state.blocks[0].content.text).toBe('Unsaved text');
  expect(f.state.brane.title).toBe('Local title');
  expect(next.draft.title).toBeUndefined();
});
it('an in-flight save from a disposed workspace cannot clear another actor or recovered draft', async () => {
  const f = await fixture();
  f.c.edit(f.block, 'Old actor');
  const gate = deferred<{ version: number; content: { format: 'text'; text: string } }>();
  f.intercept((path) => (path === '/blocks/live' ? gate.promise : undefined));
  const pending = f.c.saveBlock(f.block);
  await useInteraction.getState().flushRecovery();
  await settle();
  f.c.dispose();
  await useInteraction.getState().initialize(crypto.randomUUID());
  useInteraction.getState().draft(f.block, 'New actor', 0, '');
  gate.resolve({ version: 1, content: { format: 'text', text: 'Old actor' } });
  await pending;
  expect(useInteraction.getState().drafts[f.block]).toBe('New actor');
});
it('recovers a draft without autosaving it, and makes conflict resolution an explicit command', async () => {
  const f = await fixture();
  f.state.blocks[0].version = 1;
  f.state.blocks[0].content.text = 'Remote';
  await f.c.refresh();
  const draft: Draft = {
    key: crypto.randomUUID(),
    actor: f.actor,
    blockId: f.block,
    text: 'Recovered',
    baseText: '',
    baseVersion: 0,
    updatedAt: 0,
  };
  f.c.recoverDraft(draft);
  await expect(f.c.saveBlock(f.block)).rejects.toThrow('Resolve');
  expect(f.sent.filter((r) => r.path === '/blocks/live')).toEqual([]);
  await f.c.overwriteDraft(f.block);
  expect(f.state.blocks[0]).toMatchObject({ version: 2, content: { text: 'Recovered' } });
  expect(useInteraction.getState().drafts[f.block]).toBeUndefined();
});
it('composer context has a single scoped owner and ignores stale lineage and estimate responses', async () => {
  const f = await fixture();
  const oldLineage = deferred<unknown[]>(),
    oldEstimate = deferred<unknown>();
  f.intercept((path) =>
    path.endsWith('/first')
      ? oldLineage.promise
      : path === '/runs/estimate'
        ? oldEstimate.promise
        : undefined,
  );
  f.c.updateDraft({ prompt: 'First', references: [f.block], continueFrom: 'first' });
  await vi.advanceTimersByTimeAsync(400);
  f.c.updateDraft({ prompt: '', references: [], continueFrom: undefined });
  oldLineage.resolve([{ id: 'old' }]);
  oldEstimate.resolve({ reservedMicrousd: 999, canAfford: true });
  await settle();
  expect(f.c.lineage).toEqual([]);
  expect(f.c.estimate).toBeUndefined();
  expect(useInteraction.getState()).not.toHaveProperty('references');
  expect(f.make('other').draft).toEqual({});
  expect(f.make().draft).toMatchObject({ references: [], prompt: '' });
});
it.each(['run', 'spawn'] as const)(
  '%s sends edits atomically and uses actual no-op versions while preserving newer typing',
  async (kind) => {
    const f = await fixture();
    f.state.blocks[0].content.text = 'Original edit';
    await f.c.refresh();
    f.c.updateDraft({ prompt: 'Original', references: [f.block] });
    f.c.edit(f.block, 'Original edit');
    const gate = deferred<SubmissionReceipt>();
    f.intercept((path) =>
      path === '/runs' || path === '/artifacts/spawn' ? gate.promise : undefined,
    );
    const pending = kind === 'run' ? f.c.run() : f.c.spawn(f.block, f.state.placements[0].id);
    await settle();
    const sent = f.sent.find((r) => r.path === (kind === 'run' ? '/runs' : '/artifacts/spawn'))!;
    expect(sent.body.edits).toEqual([{ blockId: f.block, text: 'Original edit', version: 0 }]);
    expect(f.sent.filter((r) => r.path === '/blocks/live')).toEqual([]);
    f.c.edit(f.block, 'Newer typing');
    f.c.updateDraft({ prompt: 'Newer prompt' });
    gate.resolve(f.receipt(sent.body.edits, 0));
    await pending;
    expect(useInteraction.getState().draftRecords[f.block]).toMatchObject({
      text: 'Newer typing',
      baseVersion: 0,
    });
    expect(f.c.draft.prompt).toBe('Newer prompt');
  },
);
it.each(['run', 'spawn'] as const)(
  '%s retries the exact persisted request after navigation, without rebasing a different recovered draft',
  async (kind) => {
    const f = await fixture();
    f.c.updateDraft({ prompt: 'Original', references: [f.block] });
    f.c.edit(f.block, 'Original edit');
    f.intercept((path) =>
      path === '/runs' || path === '/artifacts/spawn'
        ? Promise.reject(new Error('lost response'))
        : undefined,
    );
    const submit = (c: WorkspaceController) =>
      kind === 'run' ? c.run() : c.spawn(f.block, f.state.placements[0].id);
    await submit(f.c);
    const original = structuredClone(
      f.sent.find((r) => r.path === (kind === 'run' ? '/runs' : '/artifacts/spawn'))!.body,
    );
    const oldDraft = useInteraction.getState().draftRecords[f.block];
    f.c.dispose();
    f.intercept(undefined);
    const next = f.make();
    next.start();
    await settle();
    next.recoverDraft({ ...oldDraft, text: 'Another recovered copy' });
    next.updateDraft({ prompt: 'Next prompt', references: [] });
    await submit(next);
    const submissions = f.sent.filter(
      (r) => r.path === (kind === 'run' ? '/runs' : '/artifacts/spawn'),
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[1].body).toEqual(original);
    expect(useInteraction.getState().draftRecords[f.block]).toMatchObject({
      text: 'Another recovered copy',
      baseVersion: 0,
    });
    expect(next.draft.prompt).toBe('Next prompt');
  },
);
it('treats malformed successful responses as uncertain instead of deleting the request journal', async () => {
  const f = await fixture();
  f.c.updateDraft({ prompt: 'Test' });
  f.intercept((path) => (path === '/runs' ? Promise.resolve({ invalid: true }) : undefined));
  await f.c.run();
  expect(f.c.submission.state.status).toBe('uncertain');
  expect(f.make().submission.state.status).toBe('uncertain');
});
it('pins known source versions even when there is no local draft', async () => {
  const f = await fixture();
  f.c.updateDraft({ prompt: 'Test', references: [f.block] });
  await f.c.run();
  expect(f.sent.find((r) => r.path === '/runs')!.body.edits).toEqual([
    { blockId: f.block, text: '', version: 0 },
  ]);
});

it('does not surface failures from superseded refreshes or lineage requests', async () => {
  const f = await fixture();
  const old = deferred<BraneState>(),
    lineage = deferred<unknown>();
  f.intercept((path) =>
    path === `/branes/${f.brane}`
      ? old.promise
      : path.endsWith('/old')
        ? lineage.promise
        : undefined,
  );
  const pending = f.c.refresh();
  f.c.setContinue('old');
  f.intercept(undefined);
  await f.c.refresh();
  f.c.setContinue(undefined);
  old.reject(new Error('Obsolete read'));
  lineage.reject(new Error('Obsolete lineage'));
  await pending;
  await settle();
  expect(f.c.error).toBe('');
});
it('owns import delivery and event subscriptions, and releases them on disposal', async () => {
  const f = await fixture();
  f.c.dispose();
  const task = {
    id: 'import',
    actor: f.actor,
    filename: 'image.png',
    mime: 'image/png',
    status: 'ready' as const,
    intent: {
      key: crypto.randomUUID(),
      braneId: f.brane,
      target: 'composer' as const,
      geometry: { x: 0, y: 0, width: 320, height: 300 },
    },
    result: { braneId: f.brane, blockId: f.block, placementId: f.state.placements[0].id },
    delivered: false,
  };
  const listeners = new Set<() => void>();
  const delivered = vi.fn(async () => {
    task.delivered = true;
    listeners.forEach((listener) => listener());
  });
  f.deps.imports = {
    ...f.deps.imports,
    list: () => [task],
    delivered,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const next = f.make();
  next.start();
  await settle();
  expect(next.draft.references).toEqual([f.block]);
  expect(delivered).toHaveBeenCalledOnce();
  f.deps.events.dispatchEvent(new Event('brane:reconcile'));
  await settle();
  const count = f.request.mock.calls.length;
  next.dispose();
  f.deps.events.dispatchEvent(new Event('brane:reconcile'));
  listeners.forEach((listener) => listener());
  await vi.advanceTimersByTimeAsync(5000);
  expect(listeners.size).toBe(0);
  expect(f.request.mock.calls.length).toBe(count);
});

it('captures composer intent before waiting for an earlier text write', async () => {
  const f = await fixture();
  f.c.edit(f.block, 'Saving');
  const gate = deferred<{ version: number; content: { format: 'text'; text: string } }>();
  f.intercept((path) => (path === '/blocks/live' ? gate.promise : undefined));
  const save = f.c.saveBlock(f.block);
  await useInteraction.getState().flushRecovery();
  await settle();
  f.c.updateDraft({ prompt: 'Clicked prompt', references: [f.block] });
  const run = f.c.run();
  f.c.updateDraft({ prompt: 'Next prompt', references: [] });
  gate.resolve({ version: 1, content: { format: 'text', text: 'Saving' } });
  await save;
  await run;
  expect(f.sent.find((r) => r.path === '/runs')!.body).toMatchObject({
    prompt: 'Clicked prompt',
    references: [f.block],
  });
  expect(f.c.draft).toMatchObject({ prompt: 'Next prompt', references: [] });
});
