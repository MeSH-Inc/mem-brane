import type { BraneState, PlacementEdit } from '../../shared/types/domain';

export const streamIds = [1, 2, 4, 5];
export const blockId = (index: number) => `block-${String(index).padStart(3, '0')}`;
export const placementId = (index: number) => `placement-${String(index).padStart(3, '0')}`;
export function scene(): BraneState {
  return {
    brane: { id: 'b', title: '500 cards · response stress fixture', created_at: 0, updated_at: 0 },
    blocks: Array.from({ length: 500 }, (_, i) => ({
      id: blockId(i),
      kind: 'text',
      origin: streamIds.includes(i) ? 'generated' : 'authored',
      version: 0,
      content: {
        format: 'text',
        text: streamIds.includes(i)
          ? ''
          : `Thought ${i + 1}. An independent editable artifact.\n${'A line to scroll and select.\n'.repeat(i === 0 ? 50 : 2)}`,
      },
    })),
    placements: Array.from({ length: 500 }, (_, i) => ({
      id: placementId(i),
      block_id: blockId(i),
      brane_id: 'b',
      x: 60 + (i % 4) * 360,
      y: 60 + Math.floor(i / 4) * 300,
      width: 320,
      height: 240,
      version: 0,
      z_index: 0,
    })),
    runs: streamIds.map((i) => ({
      id: `run-${i}`,
      brane_id: 'b',
      output_block_id: blockId(i),
      status: 'running',
      partial: `Stream ${i} ready`,
      model: 'mock',
      provider: 'mock',
      error: null,
      usage_json: null,
      retry_of: null,
      created_at: 0,
    })),
    derivations: [],
  };
}
const budget = {
  day: '2026-09-11',
  committedMicrousd: 0,
  availableMicrousd: 1_000_000,
  limitMicrousd: 1_000_000,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export class StressServer {
  state = scene();
  delayMs = 350;
  writes: { id: string; edit: PlacementEdit; status: number }[] = [];
  conflicts = new Set<string>();
  private holds = new Map<string, { promise: Promise<void>; release(): void }>();
  private originalFetch = window.fetch.bind(window);
  private timer?: ReturnType<typeof setInterval>;
  streamTicks = 0;
  streamFrames = 0;
  hold(id: string) {
    if (this.holds.has(id)) throw new Error(`Already holding ${id}`);
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holds.set(id, { promise, release });
  }
  release(id: string) {
    this.holds.get(id)?.release();
    this.holds.delete(id);
  }
  conflict(id: string) {
    this.conflicts.add(id);
  }
  startStreams(intervalMs = 50) {
    this.stopStreams();
    this.timer = setInterval(() => {
      this.streamTicks++;
      for (const run of this.state.runs) {
        if (run.status !== 'running') continue;
        run.partial = `Stream ${run.id} · chunk ${this.streamTicks}\n${'Streaming content remains local to this artifact.\n'.repeat(8)}`;
        window.dispatchEvent(
          new CustomEvent('brane:run', {
            detail: { braneId: 'b', runId: run.id, text: run.partial },
          }),
        );
        this.streamFrames++;
      }
    }, intervalMs);
  }
  stopStreams() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  install() {
    window.fetch = this.fetch;
  }
  private fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      location.href,
    );
    if (!url.pathname.startsWith('/api/')) return this.originalFetch(input, init);
    const path = url.pathname.slice(4),
      method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (path === '/config')
      return json({
        models: ['mock'],
        defaultModel: 'mock',
        modelCapabilities: { mock: { vision: true, pdfText: true } },
        imports: { maxBytes: 5000 },
        maxOutputTokens: 100,
        dailySpendEnforced: true,
        budget,
      });
    if (path === '/budget') return json(budget);
    if (path === '/branes/b') {
      if (method === 'PATCH') this.state.brane.title = body.title;
      return json(this.state);
    }
    if (path === '/branes') return json([this.state.brane]);
    if (path.startsWith('/context/lineage/')) return json([]);
    if (path === '/runs/estimate')
      return json({
        estimatedInputTokens: 1,
        reservedMicrousd: 0,
        canAfford: true,
        budget,
        price: {
          inputUsdPerMillion: 0,
          outputUsdPerMillion: 0,
          vision: true,
          imageTokenBound: 0,
          source: 'fixture',
          verifiedAt: '2026-09-11',
        },
      });
    if (path.startsWith('/placements/')) {
      const id = path.split('/')[2],
        placement = this.state.placements.find((p) => p.id === id);
      if (!placement) return json({ error: 'Unknown placement' }, 404);
      if (method === 'GET') return json(placement);
      const write = { id, edit: structuredClone(body) as PlacementEdit, status: 0 };
      this.writes.push(write);
      await this.holds.get(id)?.promise;
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (this.conflicts.delete(id)) {
        placement.version++;
        placement.x += 120;
      }
      if (placement.version !== body.version) {
        write.status = 409;
        return json({ error: 'Another writer moved this placement.' }, 409);
      }
      Object.assign(placement, body, { version: placement.version + 1 });
      write.status = 200;
      return json(placement);
    }
    if (path === '/blocks/live') {
      const block = this.state.blocks.find((b) => b.id === body.blockId);
      if (!block) return json({ error: 'Unknown block' }, 404);
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (block.version !== body.version)
        return json({ error: 'Another writer edited this block.' }, 409);
      if (block.content.text !== body.text) block.version++;
      block.content = { format: 'text', text: body.text };
      return json({ content: block.content, version: block.version });
    }
    if (/^\/runs\/[^/]+\/cancel$/.test(path)) {
      const run = this.state.runs.find((r) => r.id === path.split('/')[2]);
      if (run) run.status = 'cancelled';
      return json({ ok: true });
    }
    return json({ error: `The stress fixture does not implement ${method} ${path}` }, 400);
  };
}
