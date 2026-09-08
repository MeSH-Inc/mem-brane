import type { Geometry, Placement } from '../../shared/types/domain';

type Intent = { sequence: number; geometry: Geometry };
type Waiter = { sequence: number; resolve: () => void; reject: (error: Error) => void };
type Entry = {
  saved: Placement;
  version: number;
  desired?: Intent;
  active: boolean;
  error?: Error;
  waiters: Waiter[];
};
export interface PlacementTransport {
  write: (id: string, geometry: Geometry, version: number) => Promise<Placement>;
  read: (id: string) => Promise<Placement>;
}
// One lane per placement. A refresh can update the known saved state, but cannot
// rebase an already queued intent onto another writer's version implicitly.
export class PlacementSaves {
  private entries = new Map<string, Entry>();
  private sequence = 0;
  private revision = 0;
  private listeners = new Set<() => void>();
  constructor(private transport: PlacementTransport) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.revision;
  private emit() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  private accept(entry: Entry, placement: Placement) {
    if (placement.version >= entry.saved.version) entry.saved = placement;
  }
  observe(placements: Placement[]) {
    let removed = false;
    const visible = new Set(placements.map((p) => p.id));
    for (const [id, entry] of this.entries) {
      if (!visible.has(id)) {
        entry.desired = undefined;
        for (const waiter of entry.waiters) waiter.reject(new Error('Placement removed.'));
        entry.waiters = [];
        this.entries.delete(id);
        removed = true;
      }
    }
    for (const placement of placements) {
      const entry = this.entries.get(placement.id);
      if (entry) this.accept(entry, placement);
      else
        this.entries.set(placement.id, {
          saved: placement,
          version: placement.version,
          active: false,
          waiters: [],
        });
    }
    // Wake flush waiters when removal cancels the last pending request.
    if (removed) this.emit();
  }
  project(placements: Placement[]): Placement[] {
    return placements.map((placement) => {
      const entry = this.entries.get(placement.id);
      if (!entry) return placement;
      const saved = entry.saved.version >= placement.version ? entry.saved : placement;
      return entry.desired ? { ...saved, ...entry.desired.geometry } : saved;
    });
  }
  failures() {
    return [...this.entries].flatMap(([id, e]) =>
      e.error ? [{ id, message: e.error.message, busy: e.active }] : [],
    );
  }
  hasPending() {
    return [...this.entries.values()].some((e) => !!e.desired);
  }
  flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const error = [...this.entries.values()].find((e) => e.error)?.error;
        if (error) {
          unsubscribe();
          reject(error);
        } else if (!this.hasPending()) {
          unsubscribe();
          resolve();
        }
      };
      const unsubscribe = this.subscribe(check);
      check();
    });
  }
  save(placement: Placement, geometry: Geometry): Promise<void> {
    let entry = this.entries.get(placement.id);
    if (!entry) {
      entry = { saved: placement, version: placement.version, active: false, waiters: [] };
      this.entries.set(placement.id, entry);
    }
    if (placement.version > entry.saved.version) this.accept(entry, placement);
    if (!entry.active && !entry.desired) entry.version = entry.saved.version;
    const sequence = ++this.sequence;
    entry.desired = { sequence, geometry: { ...geometry } };
    this.emit();
    if (entry.error) return Promise.reject(entry.error);
    const promise = new Promise<void>((resolve, reject) =>
      entry.waiters.push({ sequence, resolve, reject }),
    );
    void this.drain(placement.id, entry);
    return promise;
  }
  private async drain(id: string, entry: Entry) {
    if (entry.active || entry.error) return;
    entry.active = true;
    try {
      while (entry.desired) {
        const intent = entry.desired;
        const saved = await this.transport.write(id, intent.geometry, entry.version);
        if (this.entries.get(id) !== entry) return;
        this.accept(entry, saved);
        entry.version = saved.version;
        if (entry.desired.sequence === intent.sequence) entry.desired = undefined;
        const done = entry.waiters.filter((w) => w.sequence <= intent.sequence);
        entry.waiters = entry.waiters.filter((w) => w.sequence > intent.sequence);
        for (const waiter of done) waiter.resolve();
        this.emit();
      }
    } catch (cause) {
      entry.error = cause instanceof Error ? cause : new Error('Could not save this placement.');
      // Keep the newest local intent visible. No error-driven refresh or rollback
      // may replace it; retry and discard are explicit user decisions.
      for (const waiter of entry.waiters) waiter.reject(entry.error);
      entry.waiters = [];
    } finally {
      entry.active = false;
      this.emit();
    }
  }
  async retry(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.error || entry.active) return;
    entry.active = true;
    this.emit();
    try {
      const current = await this.transport.read(id);
      if (this.entries.get(id) !== entry) return;
      this.accept(entry, current);
      entry.version = entry.saved.version;
      entry.error = undefined;
    } catch (cause) {
      entry.error = cause instanceof Error ? cause : new Error('Could not reload this placement.');
    } finally {
      entry.active = false;
      this.emit();
    }
    await this.drain(id, entry);
  }
  async discard(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.error || entry.active) return;
    // Refresh first: a lost response may have committed, so the old base is not
    // proof of the current server position. Preserve the intent if this read fails.
    entry.active = true;
    const sequence = entry.desired?.sequence;
    this.emit();
    try {
      const current = await this.transport.read(id);
      if (this.entries.get(id) !== entry) return;
      this.accept(entry, current);
      if (entry.desired?.sequence === sequence) {
        entry.desired = undefined;
        entry.error = undefined;
      }
    } catch (cause) {
      entry.error = cause instanceof Error ? cause : new Error('Could not reload this placement.');
    } finally {
      entry.active = false;
      this.emit();
    }
  }
}
